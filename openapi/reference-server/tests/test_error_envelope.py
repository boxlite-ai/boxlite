from __future__ import annotations

import ast
import importlib.util
import inspect
import re
import sys
import unittest
from pathlib import Path


ERRORS_PATH = Path(__file__).resolve().parents[1] / "errors.py"
SERVER_PATH = Path(__file__).resolve().parents[1] / "server.py"
SPEC = importlib.util.spec_from_file_location("reference_server_errors", ERRORS_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Failed to load errors module spec from {ERRORS_PATH}")
ERRORS = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = ERRORS
SPEC.loader.exec_module(ERRORS)

REPO_ROOT = Path(__file__).resolve().parents[3]
OPENAPI_SPEC = REPO_ROOT / "openapi" / "box.openapi.yaml"
RUST_ERRORS = REPO_ROOT / "src" / "shared" / "src" / "errors.rs"


def spec_enum(field: str) -> set[str]:
    """The values `box.openapi.yaml` allows for `ErrorModel.<field>`.

    Read out of the spec rather than restated here: the point of the
    assertions below is that two independently maintained artifacts agree,
    and a copy of the enum in this file would agree with itself.
    """
    lines = OPENAPI_SPEC.read_text().splitlines()
    start = lines.index("    ErrorModel:")
    end = next(
        (
            i
            for i in range(start + 1, len(lines))
            if re.match(r"^    \w", lines[i])
        ),
        len(lines),
    )

    section = lines[start:end]
    field_at = section.index(f"        {field}:")
    values: set[str] = set()
    in_enum = False
    for line in section[field_at + 1 :]:
        if re.match(r"^        \w", line):
            break
        if line.strip() == "enum:":
            in_enum = True
            continue
        if in_enum:
            item = re.match(r"^            - (\S+)$", line)
            if item is None:
                break
            values.add(item.group(1))
    return values


def display_prefixes() -> list[str]:
    """Every `BoxliteError` Display prefix, read off the enum that emits it.

    `classify_error` recovers the class from this text because the Python SDK
    raises every runtime failure as a bare `RuntimeError` carrying it — so a
    variant whose prefix no row matches is a variant the server answers as a
    server fault.
    """
    source = RUST_ERRORS.read_text()
    return [
        literal.replace("{0}", "").rstrip()
        for literal in re.findall(r'#\[error\("([^"]*)"\)\]', source)
    ]


def hand_written_classes() -> list[tuple[int, str, str]]:
    """Every `(line, error_type, code)` pair `server.py` names as a literal.

    `classify_error` answers for failures the runtime raises, but the routes
    that fail before reaching it — a missing bearer token, a snapshot that is
    not there, an empty import body — name the class inline. Nothing checks
    those strings, and one of them had drifted to a `ValidationError` that
    `box.openapi.yaml` does not declare.

    Parsed rather than imported: `server.py` needs fastapi, pydantic and the
    boxlite binding, none of which this suite requires. Which argument holds
    which value is read from each function's own signature, so reordering the
    parameters cannot leave this checking the wrong ones.
    """
    tree = ast.parse(SERVER_PATH.read_text())

    params = {
        "error_envelope": list(inspect.signature(ERRORS.error_envelope).parameters)
    }
    for node in ast.walk(tree):
        if isinstance(node, ast.FunctionDef) and node.name == "error_response":
            params["error_response"] = [arg.arg for arg in node.args.args]

    found: list[tuple[int, str, str]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        names = params.get(getattr(node.func, "id", None))
        if names is None:
            continue

        bound = dict(zip(names, node.args))
        bound.update({kw.arg: kw.value for kw in node.keywords if kw.arg})
        chosen = [bound.get("error_type"), bound.get("code")]
        # The two dispatchers forward `classify_error`'s result, so their
        # arguments are names, not literals — those rows are covered by
        # test_every_class_is_one_the_spec_declares instead.
        if not all(
            isinstance(a, ast.Constant) and isinstance(a.value, str) for a in chosen
        ):
            continue
        found.append((node.lineno, chosen[0].value, chosen[1].value))

    return found


class ErrorEnvelopeTests(unittest.TestCase):
    # The refusal the guest emits for a destination a mount hides, verbatim
    # from `unreachable_mount_message` (src/guest/src/service/files.rs), under
    # the `unsupported: ` prefix `map_tonic_err` gives a FailedPrecondition.
    REFUSAL = (
        "unsupported: /tmp/ghost.txt is under the container's '/tmp' mount, "
        "which file transfer cannot reach; copy to a path outside '/tmp' "
        '(for example /workspace), or pipe a tar through exec: '
        'exec(["tar", "xf", "-", "-C", "/tmp"])'
    )

    def test_a_refused_copy_is_answered_as_the_callers_mistake(self) -> None:
        """A path a mount hides is refused, and the refusal says so.

        Both file routes report a failed `copy_in`/`copy_out` through here.
        Calling it a 500 would report a server fault for a request only the
        caller can fix, and would contradict the `400` box.openapi.yaml
        declares on both routes.
        """
        status, error_type, code = ERRORS.classify_error(self.REFUSAL)

        self.assertEqual(status, 400)
        self.assertEqual(error_type, "UnsupportedError")
        self.assertEqual(code, "unsupported")

    def test_the_envelope_carries_the_machine_code_clients_dispatch_on(self) -> None:
        """`error.code` is the stable snake_case identifier, not the status.

        The client derives a baseline variant from the HTTP status and lets
        `code` refine it (src/boxlite/src/rest/error.rs), and box.openapi.yaml
        types it `string`. Repeating the numeric status there matches no arm,
        so the specific variant this server named is lost and the caller is
        left with the status baseline.
        """
        status, error_type, code = ERRORS.classify_error(self.REFUSAL)
        body = ERRORS.error_envelope(self.REFUSAL, error_type, code)

        self.assertEqual(
            set(body["error"]), {"message", "type", "code"}, body
        )
        self.assertEqual(body["error"]["code"], "unsupported")
        self.assertNotEqual(
            body["error"]["code"],
            status,
            "code must be the machine identifier, not the HTTP status",
        )
        self.assertIn("'/tmp' mount", body["error"]["message"])

    def test_every_class_is_one_the_spec_declares(self) -> None:
        """Nothing this server emits may fall outside the spec's enums."""
        allowed_types = spec_enum("type")
        allowed_codes = spec_enum("code")
        self.assertTrue(allowed_types and allowed_codes, "spec enums not found")

        for prefix, status, error_type, code in ERRORS.ERROR_MAP:
            with self.subTest(prefix=prefix):
                self.assertIn(error_type, allowed_types)
                self.assertIn(code, allowed_codes)
                self.assertIsInstance(status, int)

    def test_every_class_named_in_a_route_is_one_the_spec_declares(self) -> None:
        """The routes that classify inline are held to the same enums.

        `test_every_class_is_one_the_spec_declares` covers the table; these are
        the sites that bypass it. A class outside the enums is one the client's
        code table has no arm for, so the caller is left with the variant the
        HTTP status implies — the same way a numeric `code` is.
        """
        allowed_types = spec_enum("type")
        allowed_codes = spec_enum("code")
        classes = hand_written_classes()
        self.assertGreaterEqual(len(classes), 8, classes)

        for line, error_type, code in classes:
            with self.subTest(line=line):
                self.assertIn(error_type, allowed_types)
                self.assertIn(code, allowed_codes)

    def test_every_runtime_error_variant_has_a_class(self) -> None:
        """A variant no row matches is answered as a server fault.

        Reads the prefixes from the Rust enum, so adding a `BoxliteError`
        variant without a row here fails rather than silently degrading to
        `500 InternalError`.
        """
        prefixes = display_prefixes()
        self.assertEqual(len(prefixes), 21, prefixes)

        unmatched = [
            prefix
            for prefix in prefixes
            if not any(prefix.startswith(row[0]) for row in ERRORS.ERROR_MAP)
        ]
        self.assertEqual(unmatched, [])


if __name__ == "__main__":
    unittest.main()
