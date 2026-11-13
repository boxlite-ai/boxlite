#!/usr/bin/env python3
"""Compile OpenAPI request-version declarations; check additions against a Git base."""

import argparse
import json
from pathlib import Path
import re
import subprocess

import yaml

ROOT = Path(__file__).resolve().parents[1]
SPEC = "openapi/box.openapi.yaml"
OUTPUT = ROOT / "src/boxlite/src/rest/version_rules.json"
API_VERSION = OUTPUT.with_name("api_version.json")
PENDING = {"next-release", "unplanned"}
MINIMUM = "x-boxlite-min-server-version"
CONDITION = "x-boxlite-version-check"
METHODS = {"get", "head", "post", "put", "patch", "delete", "options"}


def version(value):
    """SemVer precedence key, excluding build metadata (semver.org §11)."""
    match = re.fullmatch(
        r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)"
        r"(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?"
        r"(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?", str(value)
    )
    if not isinstance(value, str) or not match:
        raise ValueError(f"invalid SemVer: {value!r}")
    numbers = tuple(map(int, match.group(1, 2, 3)))
    if any(n > 2**64 - 1 for n in numbers):
        raise ValueError(f"SemVer component overflow: {value}")
    pre = match.group(4)
    parts = []
    for item in pre.split(".") if pre else []:
        if item.isdigit() and len(item) > 1 and item[0] == "0":
            raise ValueError(f"invalid numeric prerelease: {value}")
        parts.append((0, int(item)) if item.isdigit() else (1, item))
    return numbers, pre is None, tuple(parts)


def validate_minimum(value):
    if isinstance(value, str) and value in PENDING:
        return
    version(value)


class Contract:
    def __init__(self, spec):
        self.spec = spec

    def resolve(self, node, seen=()):
        if not isinstance(node, dict):
            return node
        if "$ref" not in node:
            return node
        ref = node["$ref"]
        if not ref.startswith("#/") or ref in seen:
            raise ValueError(f"external or cyclic reference: {ref}")
        target = self.spec
        for part in ref[2:].split("/"):
            target = target[part.replace("~1", "/").replace("~0", "~")]
        target = self.resolve(target, (*seen, ref))
        siblings = {k: v for k, v in node.items() if k != "$ref"}
        merged = {**target, **siblings}
        # OpenAPI 3.1 schema reference siblings add constraints. A sibling
        # properties block must not erase the referenced request inventory.
        if "properties" in target and "properties" in siblings:
            properties = dict(target["properties"])
            for key, value in siblings["properties"].items():
                properties[key] = {"allOf": [properties[key], value]} if key in properties else value
            merged["properties"] = properties
        if "allOf" in target and "allOf" in siblings:
            merged["allOf"] = target["allOf"] + siblings["allOf"]
        return merged

    def walk(self, schema, path=(), seen=()):
        """Yield request properties, including inventory beneath unsupported shapes.

        allOf object properties are conjunctive and keep their JSON pointer.
        Union/array/map descendants are inventoried for CI, but cannot carry
        rules until the evaluator supports those conditional/repeated paths.
        """
        if not isinstance(schema, dict):
            return
        ref = schema.get("$ref")
        if ref and ref in seen:
            raise ValueError(f"cyclic request schema: {ref}")
        node = self.resolve(schema)
        if node.get("readOnly"):
            return
        chain = (*seen, ref) if ref else seen
        yield path, node
        for name, child in node.get("properties", {}).items():
            yield from self.walk(child, (*path, name), chain)
        for child in node.get("allOf", []):
            yield from self.walk(child, path, chain)
        for kind in ("oneOf", "anyOf", "items", "additionalProperties", "not", "if", "then", "else",
                     "prefixItems", "contains", "unevaluatedProperties", "patternProperties", "dependentSchemas"):
            children = node.get(kind, [])
            if kind in {"patternProperties", "dependentSchemas"}:
                children = list(children.values()) if isinstance(children, dict) else []
            if not isinstance(children, list):
                children = [children]
            for child in children:
                yield from self.walk(child, (*path, "*"), chain)

    def rule(self, node, location, path):
        if MINIMUM not in node:
            if CONDITION in node:
                raise ValueError(f"{path}: condition without minimum")
            return None
        validate_minimum(node[MINIMUM])
        condition = node.get(CONDITION)
        if condition not in {"present", "non-default"}:
            raise ValueError(f"{path}: expected present or non-default condition")
        if "*" in path:
            raise ValueError(f"{path}: annotations inside unions, arrays or maps are unsupported")
        rule = {"location": location, "path": list(path), "minimum": node[MINIMUM], "condition": condition}
        if condition == "non-default":
            # Bound the initial feature to scalar defaults; present works on
            # whole objects/arrays without interpreting their contents.
            kind = node.get("type")
            default = node.get("default")
            types = {"boolean": bool, "string": str, "integer": int, "number": (int, float)}
            expected = types.get(kind) if isinstance(kind, str) else None
            if "default" not in node or not expected or not isinstance(default, expected):
                raise ValueError(f"{path}: non-default needs a matching scalar default")
            if kind in {"integer", "number"} and isinstance(default, bool):
                raise ValueError(f"{path}: boolean is not a numeric default")
            if "enum" in node and default not in node["enum"]:
                raise ValueError(f"{path}: default is outside its enum")
            rule["default"] = default
        if location != "body":
            kind = node.get("type")
            if kind not in {"boolean", "string", "integer", "number"}:
                raise ValueError(f"{path}: only scalar parameter rules are supported")
            rule["type"] = kind
        return rule

    def operations(self):
        operations = []
        ids = set()
        for path, raw_item in self.spec["paths"].items():
            if not path.startswith("/") or any(
                ("{" in segment or "}" in segment) and not re.fullmatch(r"\{[^{}]+\}", segment)
                for segment in path.split("/")
            ):
                raise ValueError(f"only whole-segment route parameters are supported: {path}")
            item = self.resolve(raw_item)
            for method in sorted(METHODS & item.keys()):
                op = item[method]
                name = op["operationId"]
                if name in ids:
                    raise ValueError(f"duplicate operationId: {name}")
                ids.add(name)
                result = {"method": method.upper(), "path": path, "operation": name, "rules": []}
                if MINIMUM in op:
                    validate_minimum(op[MINIMUM])
                    result["minimum"] = op[MINIMUM]
                if CONDITION in op:
                    raise ValueError(f"{name}: operations cannot have field conditions")
                fields = {}
                parameters = {}
                for raw in item.get("parameters", []) + op.get("parameters", []):
                    param = self.resolve(raw)
                    parameters[param["in"], param["name"]] = param
                for (location, param_name), param in parameters.items():
                    schema = self.resolve(param.get("schema", {}))
                    node = {**schema, **{k: v for k, v in param.items() if k.startswith("x-boxlite-")}}
                    rule = self.rule(node, location, (param_name,))
                    fields[(location, param_name)] = node.get(MINIMUM)
                    for media in param.get("content", {}).values():
                        for pointer, child in self.walk(media.get("schema", {})):
                            fields[(location, param_name, *pointer)] = child.get(MINIMUM)
                            if MINIMUM in child or CONDITION in child:
                                raise ValueError(f"{name}: parameter content annotations are unsupported")
                    if rule:
                        if location not in {"query", "header", "path"} or "content" in param:
                            raise ValueError(f"{name}: unsupported parameter annotation")
                        result["rules"].append(rule)
                body = self.resolve(op.get("requestBody", {}))
                if MINIMUM in body or CONDITION in body:
                    raise ValueError(f"{name}: annotate the operation or a request property, not requestBody")
                for media, content in body.get("content", {}).items():
                    if MINIMUM in content or CONDITION in content:
                        raise ValueError(f"{name}: media-type annotations are unsupported")
                    for pointer, node in self.walk(content.get("schema", {})):
                        if pointer:
                            key = ("body", *pointer)
                            minimum = node.get(MINIMUM)
                            if minimum or key not in fields:
                                fields[key] = minimum
                        rule = self.rule(node, "body", pointer)
                        if rule:
                            if media != "application/json" or not pointer:
                                raise ValueError(f"{name}: rules need JSON properties")
                            result["rules"].append(rule)
                result["fields"] = fields
                operations.append(result)
        # Reject overlapping templates unless one is strictly more concrete.
        # /images/usage wins over /images/{name}; /{a}/x vs /y/{b} is ambiguous.
        for i, left in enumerate(operations):
            for right in operations[i + 1:]:
                a, b = left["path"].split("/"), right["path"].split("/")
                if left["method"] != right["method"] or len(a) != len(b):
                    continue
                variable = lambda s: s.startswith("{") and s.endswith("}")
                if all(x == y or variable(x) or variable(y) for x, y in zip(a, b)):
                    more_a = any(not variable(x) and variable(y) for x, y in zip(a, b))
                    more_b = any(variable(x) and not variable(y) for x, y in zip(a, b))
                    if more_a == more_b:
                        raise ValueError(f"ambiguous routes: {left['path']} and {right['path']}")
        return sorted(operations, key=lambda op: (op["method"], op["path"]))


def check_additions(before, after, base_version):
    baseline = {(op["method"], op["path"]): op for op in Contract(before).operations()}
    base = version(base_version)
    for op in Contract(after).operations():
        old = baseline.get((op["method"], op["path"]))
        future = lambda v: v in PENDING or (v is not None and version(v) > base)
        if old is None:
            if not future(op.get("minimum")):
                raise ValueError(f"{op['operation']}: new operation needs minimum > {base_version}")
            continue
        for field, minimum in op["fields"].items():
            if field in old["fields"]:
                continue
            # A new parent property or a newly gated whole operation covers
            # its descendants as well. Existing old minima cannot cover them.
            ancestors = [op["fields"].get(field[:n]) for n in range(2, len(field))]
            if not any(future(v) for v in [minimum, op.get("minimum"), *ancestors]):
                raise ValueError(f"{op['operation']} {field}: new request field needs minimum > {base_version}")


def api_version(spec, workspace):
    version(workspace)
    declared = spec["info"]["version"]
    if declared == "next-release":
        return workspace
    if declared != workspace:
        raise ValueError("OpenAPI info.version must match the workspace release or be next-release")
    return workspace


def validate_release(spec, workspace, *, releasing=False):
    identity = api_version(spec, workspace)
    if releasing and spec["info"]["version"] == "next-release":
        raise ValueError("next-release must be finalized before publication")
    for operation in Contract(spec).operations():
        for node in [operation, *operation["rules"]]:
            value = node.get("minimum")
            if value == "next-release" and spec["info"]["version"] != "next-release":
                raise ValueError("next-release requires info.version: next-release")
            # Numeric declarations refer to current or previous product releases.
            if value is not None and value not in PENDING and version(value) > version(workspace):
                raise ValueError(f"{operation['operation']}: minimum {value} is newer than workspace {workspace}")
    return identity


def finalize(text, workspace, base_version):
    if not re.fullmatch(r"(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)", workspace):
        raise ValueError("finalization requires a stable workspace version")
    if version(workspace) <= version(base_version):
        raise ValueError("bump the workspace version above the Git base before finalizing")
    before = Contract(yaml.safe_load(text)).operations()
    # Scalar spans preserve comments, anchors, and formatting in the authoritative spec.
    replacements = {}
    scalars = [token for token in yaml.scan(text) if isinstance(token, yaml.ScalarToken)]
    visited = set()
    def walk(node, path=()):
        if id(node) in visited:
            return
        visited.add(id(node))
        if isinstance(node, yaml.MappingNode):
            for key, value in node.value:
                if (path == ("info",) and key.value == "version") or (
                    key.value == MINIMUM and value.value == "next-release"
                ):
                    token = next(token for token in scalars
                                 if value.start_mark.index <= token.start_mark.index
                                 and token.end_mark.index <= value.end_mark.index
                                 and token.value == value.value)
                    replacements[token.start_mark.index, token.end_mark.index] = json.dumps(workspace)
                walk(value, (*path, key.value))
        elif isinstance(node, yaml.SequenceNode):
            for value in node.value:
                walk(value, path)
    walk(yaml.compose(text))
    for (start, end), value in sorted(replacements.items(), reverse=True):
        text = text[:start] + value + text[end:]
    spec = yaml.safe_load(text)
    validate_release(spec, workspace, releasing=True)
    for old, new in zip(before, Contract(spec).operations()):
        for key, value in {("operation",): old.get("minimum"), **old["fields"]}.items():
            updated = new.get("minimum") if key == ("operation",) else new["fields"].get(key)
            if value != "next-release" and value != updated:
                raise ValueError("finalization changed an existing minimum through a shared YAML anchor")
    return text


def render(spec, workspace=None):
    operations = Contract(spec).operations()
    identity = validate_release(spec, workspace) if workspace else None
    for operation in operations:
        for node in [operation, *operation["rules"]]:
            if node.get("minimum") == "next-release":
                if identity is None:
                    raise ValueError("next-release generation requires the workspace version")
                node["minimum"] = identity
    return "[\n" + ",\n".join(
        "  " + json.dumps({k: v for k, v in op.items() if k != "fields"}, separators=(",", ":"))
        for op in operations
    ) + "\n]\n"


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--check", action="store_true")
    parser.add_argument("--base", help="Git base commit for new request declarations")
    parser.add_argument("--finalize", action="store_true", help="Finalize next-release after the workspace bump; requires --base")
    parser.add_argument("--release", action="store_true", help="Refuse next-release before publishing")
    parser.add_argument("--tag", help="Release tag, which must match the workspace version")
    args = parser.parse_args()
    source = (ROOT / SPEC).read_text()
    spec = yaml.safe_load(source)
    def release_version(manifest):
        package = manifest.split("[workspace.package]", 1)[1]
        return re.search(r'^version\s*=\s*"([^"]+)"', package, re.MULTILINE).group(1)
    workspace = release_version((ROOT / "Cargo.toml").read_text())
    if args.tag and args.tag != f"v{workspace}":
        raise ValueError(f"release tag {args.tag} does not match workspace {workspace}")
    if args.finalize and (not args.base or args.check):
        raise ValueError("--finalize requires --base and cannot be combined with --check")
    if args.base:
        base_commit = subprocess.check_output(
            ["git", "rev-parse", "--verify", "--end-of-options", args.base + "^{commit}"], cwd=ROOT, text=True
        ).strip()
        def read_base(path):
            return subprocess.check_output(["git", "show", f"{base_commit}:{path}"], cwd=ROOT, text=True)
        release = release_version(read_base("Cargo.toml"))
        if args.finalize:
            source = finalize(source, workspace, release)
            spec = yaml.safe_load(source)
        check_additions(yaml.safe_load(read_base(SPEC)), spec, release)
    identity = validate_release(spec, workspace, releasing=args.release)
    outputs = {OUTPUT: render(spec, workspace), API_VERSION: json.dumps(identity) + "\n"}
    for path, output in outputs.items():
        if args.check:
            if not path.exists() or path.read_text() != output:
                raise ValueError(f"{path.name} is stale; run make generate:openapi")
        else:
            path.write_text(output)
    if args.finalize:
        (ROOT / SPEC).write_text(source)


if __name__ == "__main__":
    main()
