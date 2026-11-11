#!/usr/bin/env python3
"""Generate the shared CPU minimum; check also verifies Swag's derived schemas."""

import argparse
import json
import re
from decimal import Decimal
from pathlib import Path


def replace_exact(text, pattern, replacement, count, path):
    result, found = re.subn(pattern, replacement, text, flags=re.MULTILINE)
    if found != count:
        raise ValueError(f"{path}: expected {count} CPU declarations, found {found}")
    return result


def generated_files(root):
    policy = json.loads((root / "openapi/cpu-resources.json").read_text())
    milli = policy["minimum_millicpus"]
    if (
        set(policy) != {"minimum_millicpus"}
        or type(milli) is not int
        or not 10 <= milli <= 1000
    ):
        raise ValueError(
            "minimum_millicpus must be an integer from 10 through the default 1000"
        )
    cores = format(Decimal(milli) / 1000, "f")
    notice = (
        "Generated from openapi/cpu-resources.json; run make generate:cpu-resources."
    )
    files = {
        "src/boxlite/src/runtime/cpu_limits.rs": (
            f"// {notice}\n"
            f"pub const MIN_CPU_MILLICPU: u32 = {milli};\n"
            "pub const MIN_CPUS: f64 = MIN_CPU_MILLICPU as f64 / 1000.0;\n"
        ),
        "apps/runner/pkg/api/dto/cpu_limits.go": (
            f"// {notice}\npackage dto\n\n"
            f"const MinCPUMillicpu = {milli}\n"
            "const MinCPUs = float64(MinCPUMillicpu) / 1000\n"
        ),
        "apps/libs/resource-limits/src/cpu.ts": (
            f"// {notice}\n"
            f"export const MIN_CPU_MILLICPU = {milli}\n"
            "export const MIN_CPUS = MIN_CPU_MILLICPU / 1000\n"
        ),
    }
    # Go tags and YAML schemas cannot reference language constants. Restrict
    # edits to known CPU declarations and validate every match before writing.
    substitutions = {
        "apps/runner/pkg/api/dto/box.go": [
            (r'(^\s*CpuQuota\s+\*float64[^\n]*validate:"omitempty,min=)[\d.]+', 2),
        ],
        "openapi/box.openapi.yaml": [
            (r"(^        cpus:\n          type: number\n          minimum: )[\d.]+", 2),
            (r'(message: "invalid argument: cpus must be between )[\d.]+', 1),
        ],
        "docs/guides/resource-limits.md": [
            (r"(^\*\*Range:\*\* `)[\d.]+(?=` to `16`)", 1),
            (r"(BoxLite Cloud accepts `cpus` from `)[\d.]+(?=` to `16`)", 1),
        ],
    }
    for path, rules in substitutions.items():
        text = (root / path).read_text()
        for pattern, count in rules:
            text = replace_exact(text, pattern, lambda m: m[1] + cores, count, path)
        files[path] = text
    return files, float(cores)


def check_swagger(root, minimum):
    directory = root / "apps/runner/pkg/api/docs"
    document = json.loads((directory / "swagger.json").read_text())
    for schema in ("CreateBoxDTO", "RecoverBoxDTO"):
        actual = document["definitions"][schema]["properties"]["cpuQuota"]["minimum"]
        if actual != minimum:
            raise ValueError(
                f"Runner {schema} minimum is stale; regenerate runner:openapi"
            )
    for name, pattern in (
        ("docs.go", r'"cpuQuota":\s*\{[^}]*?"minimum":\s*([\d.]+)'),
        (
            "swagger.yaml",
            r"      cpuQuota:\n(?:        [^\n]*\n)*?        minimum: ([\d.]+)",
        ),
    ):
        values = re.findall(
            pattern,
            (directory / name).read_text(),
            re.DOTALL if name == "docs.go" else 0,
        )
        if len(values) != 2 or any(float(value) != minimum for value in values):
            raise ValueError(
                f"Runner {name} CPU bounds are stale; regenerate runner:openapi"
            )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--root", type=Path, default=Path(__file__).resolve().parents[1]
    )
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    try:
        files, minimum = generated_files(args.root)
        stale = [
            path
            for path, text in files.items()
            if not (args.root / path).is_file()
            or (args.root / path).read_text() != text
        ]
        if args.check:
            if stale:
                raise ValueError("stale CPU resources: " + ", ".join(stale))
            check_swagger(args.root, minimum)
        else:
            for path in stale:
                target = args.root / path
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(files[path])
        print(f"CPU minimum {minimum:g}: {'checked' if args.check else 'generated'}")
    except (OSError, ValueError, KeyError, TypeError) as error:
        parser.exit(1, f"CPU resources: {error}\n")


if __name__ == "__main__":
    main()
