#!/usr/bin/env python3
# Consolidate every TypeORM migration in apps/api/src/migrations/ (legacy +
# pre-deploy/ + post-deploy/) into a single merged-schema SQL script that can
# create the apps/api database from scratch in one step.
#
# The script:
#   1. Sorts every *-migration.ts by the leading numeric timestamp.
#   2. Parses the up() body of each migration and extracts every
#      queryRunner.query(`...`) call in source order.
#   3. Resolves TS-side ${...} interpolations against a hardcoded constants
#      table (GlobalOrganizationRolesIds, OrganizationResourcePermission,
#      configuration.defaultRegion.id) — these are the only interpolations
#      used in up() across the full migration history.
#   4. Inlines parameterized queries (`, [param1, param2]`) by substituting
#      $1/$2 with PostgreSQL string/array literals. Parameterised queries
#      that live inside a JS for-loop (data backfills) are skipped — on a
#      fresh database they would loop over zero rows anyway.
#   5. Skips read-only SELECTs that are assigned to a const (data probes
#      that only matter for incremental migrations).
#   6. Appends INSERTs into the typeorm "migrations" tracking table so that
#      a subsequent `npm run migration:run` is a no-op.
#
# Output: apps/infra-local/sql/merged-schema.auto-gen.sql

from __future__ import annotations

import re
import sys
from pathlib import Path

SCRIPT_DIR = Path(__file__).resolve().parent  # apps/infra-local/scripts
INFRA_LOCAL_ROOT = SCRIPT_DIR.parent  # apps/infra-local
REPO_ROOT = INFRA_LOCAL_ROOT.parent.parent  # apps/infra-local -> apps -> repo root
API_ROOT = REPO_ROOT / "apps" / "api"
MIGRATIONS_DIR = API_ROOT / "src" / "migrations"
OUTPUT_FILE = INFRA_LOCAL_ROOT / "sql" / "merged-schema.auto-gen.sql"

# Source-of-truth values, lifted from:
#   apps/api/src/organization/constants/global-organization-roles.constant.ts
#   apps/api/src/organization/enums/organization-resource-permission.enum.ts
#   apps/api/src/config/configuration.ts (defaultRegion.id default)
CONSTANTS: dict[str, str] = {
    "GlobalOrganizationRolesIds.DEVELOPER": "00000000-0000-0000-0000-000000000001",
    "GlobalOrganizationRolesIds.SANDBOXES_ADMIN": "00000000-0000-0000-0000-000000000002",
    "GlobalOrganizationRolesIds.SNAPSHOTS_ADMIN": "00000000-0000-0000-0000-000000000003",
    "GlobalOrganizationRolesIds.REGISTRIES_ADMIN": "00000000-0000-0000-0000-000000000004",
    "GlobalOrganizationRolesIds.SUPER_ADMIN": "00000000-0000-0000-0000-000000000005",
    "GlobalOrganizationRolesIds.VOLUMES_ADMIN": "00000000-0000-0000-0000-000000000006",
    "GlobalOrganizationRolesIds.AUDITOR": "00000000-0000-0000-0000-000000000007",
    "GlobalOrganizationRolesIds.INFRASTRUCTURE_ADMIN": "00000000-0000-0000-0000-000000000008",
    "OrganizationResourcePermission.WRITE_REGISTRIES": "write:registries",
    "OrganizationResourcePermission.DELETE_REGISTRIES": "delete:registries",
    "OrganizationResourcePermission.WRITE_SNAPSHOTS": "write:snapshots",
    "OrganizationResourcePermission.DELETE_SNAPSHOTS": "delete:snapshots",
    "OrganizationResourcePermission.WRITE_SANDBOXES": "write:sandboxes",
    "OrganizationResourcePermission.DELETE_SANDBOXES": "delete:sandboxes",
    "OrganizationResourcePermission.READ_VOLUMES": "read:volumes",
    "OrganizationResourcePermission.WRITE_VOLUMES": "write:volumes",
    "OrganizationResourcePermission.DELETE_VOLUMES": "delete:volumes",
    "OrganizationResourcePermission.WRITE_REGIONS": "write:regions",
    "OrganizationResourcePermission.DELETE_REGIONS": "delete:regions",
    "OrganizationResourcePermission.READ_RUNNERS": "read:runners",
    "OrganizationResourcePermission.WRITE_RUNNERS": "write:runners",
    "OrganizationResourcePermission.DELETE_RUNNERS": "delete:runners",
    "OrganizationResourcePermission.READ_AUDIT_LOGS": "read:audit_logs",
    "configuration.defaultRegion.id": "us",
}

CLASS_NAME_RE = re.compile(r"export class (Migration\d+)")


# ---------------------------------------------------------------------------
# Schema state — used to mirror TypeORM's auto-rename behaviour for enum
# types when a table/column is renamed. TypeORM detects enum columns whose
# type name follows the `<table>_<column>_enum` convention and renames the
# type alongside the table/column so the convention keeps holding.
# ---------------------------------------------------------------------------


class SchemaState:
    """Lightweight in-memory model of the database schema, updated as SQL
    statements are emitted. Only tracks what we need to mimic TypeORM's
    auto-rename of enum types: tables → {column → type_name}."""

    def __init__(self) -> None:
        self.tables: dict[str, dict[str, str]] = {}
        self.types: set[str] = set()

    # -- mutation helpers -------------------------------------------------
    def add_table(self, name: str, columns: dict[str, str]) -> None:
        self.tables[name] = dict(columns)

    def drop_table(self, name: str) -> None:
        self.tables.pop(name, None)

    def rename_table(self, old: str, new: str) -> None:
        if old in self.tables:
            self.tables[new] = self.tables.pop(old)

    def add_column(self, table: str, col: str, type_name: str) -> None:
        self.tables.setdefault(table, {})[col] = type_name

    def drop_column(self, table: str, col: str) -> None:
        if table in self.tables:
            self.tables[table].pop(col, None)

    def rename_column(self, table: str, old: str, new: str) -> None:
        if table in self.tables and old in self.tables[table]:
            self.tables[table][new] = self.tables[table].pop(old)

    def column_type(self, table: str, col: str) -> str | None:
        return self.tables.get(table, {}).get(col)

    def set_column_type(self, table: str, col: str, type_name: str) -> None:
        if table in self.tables:
            self.tables[table][col] = type_name

    def add_type(self, name: str) -> None:
        self.types.add(name)

    def drop_type(self, name: str) -> None:
        self.types.discard(name)

    def rename_type(self, old: str, new: str) -> None:
        if old in self.types:
            self.types.discard(old)
            self.types.add(new)
        # rewrite any table column that referenced the old type
        for cols in self.tables.values():
            for c, t in list(cols.items()):
                if t == old:
                    cols[c] = new


# ---------------------------------------------------------------------------
# SQL statement parsers — minimal, only enough to keep SchemaState honest.
# ---------------------------------------------------------------------------


_IDENT = r'(?:"[^"]+"|\w+)'


def _strip_ident(s: str) -> str:
    s = s.strip()
    if s.startswith('"') and s.endswith('"'):
        return s[1:-1]
    return s


def _split_top_level_commas(text: str) -> list[str]:
    parts: list[str] = []
    current: list[str] = []
    depth = 0
    state = "code"
    i = 0
    while i < len(text):
        c = text[i]
        if state == "code":
            if c == "'":
                state = "string_s"
                current.append(c)
            elif c == '"':
                state = "string_d"
                current.append(c)
            elif c == "(":
                depth += 1
                current.append(c)
            elif c == ")":
                depth -= 1
                current.append(c)
            elif c == "," and depth == 0:
                parts.append("".join(current))
                current.clear()
            else:
                current.append(c)
        elif state == "string_s":
            current.append(c)
            if c == "\\" and i + 1 < len(text):
                current.append(text[i + 1])
                i += 2
                continue
            if c == "'":
                state = "code"
        elif state == "string_d":
            current.append(c)
            if c == "\\" and i + 1 < len(text):
                current.append(text[i + 1])
                i += 2
                continue
            if c == '"':
                state = "code"
        i += 1
    if current:
        parts.append("".join(current))
    return parts


_CREATE_TABLE_RE = re.compile(
    r'^\s*CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+("(?P<name>[^"]+)"|\w+)\s*\((?P<body>.*)\)\s*$',
    re.IGNORECASE | re.DOTALL,
)
_COLUMN_RE = re.compile(
    r'^\s*"(?P<col>[^"]+)"\s+(?:"(?P<qtype>[^"]+)"|(?P<utype>\w+))',
)
_CREATE_TYPE_RE = re.compile(
    r'^\s*CREATE\s+TYPE\s+(?:"(?:public)"\.)?"(?P<name>[^"]+)"\s+AS\s+',
    re.IGNORECASE,
)
_DROP_TYPE_RE = re.compile(
    r'^\s*DROP\s+TYPE\s+(?:IF\s+EXISTS\s+)?(?:"(?:public)"\.)?"(?P<name>[^"]+)"',
    re.IGNORECASE,
)
_ALTER_TYPE_RENAME_RE = re.compile(
    r'^\s*ALTER\s+TYPE\s+(?:"(?:public)"\.)?"(?P<old>[^"]+)"\s+RENAME\s+TO\s+"(?P<new>[^"]+)"',
    re.IGNORECASE,
)
_ALTER_TABLE_RENAME_RE = re.compile(
    r'^\s*ALTER\s+TABLE\s+(?:"(?:public)"\.)?"(?P<old>[^"]+)"\s+RENAME\s+TO\s+"(?P<new>[^"]+)"',
    re.IGNORECASE,
)
_ALTER_RENAME_COLUMN_RE = re.compile(
    r'^\s*ALTER\s+TABLE\s+(?:"(?:public)"\.)?"(?P<table>[^"]+)"\s+RENAME\s+COLUMN\s+"(?P<old>[^"]+)"\s+TO\s+"(?P<new>[^"]+)"',
    re.IGNORECASE,
)
_ALTER_ADD_COL_RE = re.compile(
    r'^\s*ALTER\s+TABLE\s+(?:"(?:public)"\.)?"(?P<table>[^"]+)"\s+ADD(?:\s+COLUMN)?\s+(?:IF\s+NOT\s+EXISTS\s+)?"(?P<col>[^"]+)"\s+(?:"(?P<qtype>[^"]+)"|(?P<utype>\w+))',
    re.IGNORECASE,
)
_ALTER_DROP_COL_RE = re.compile(
    r'^\s*ALTER\s+TABLE\s+(?:"(?:public)"\.)?"(?P<table>[^"]+)"\s+DROP(?:\s+COLUMN)?\s+(?:IF\s+EXISTS\s+)?"(?P<col>[^"]+)"',
    re.IGNORECASE,
)
_ALTER_COL_TYPE_RE = re.compile(
    r'^\s*ALTER\s+TABLE\s+(?:"(?:public)"\.)?"(?P<table>[^"]+)"\s+ALTER\s+COLUMN\s+"(?P<col>[^"]+)"\s+TYPE\s+(?:"(?:public)"\.)?(?:"(?P<qtype>[^"]+)"|(?P<utype>\w+))',
    re.IGNORECASE,
)
_DROP_TABLE_RE = re.compile(
    r'^\s*DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?(?:"(?:public)"\.)?"(?P<name>[^"]+)"',
    re.IGNORECASE,
)
_RENAME_CONSTRAINT_RE = re.compile(
    r'^\s*ALTER\s+TABLE\s+(?:"(?:public)"\.)?"(?P<table>[^"]+)"\s+RENAME\s+CONSTRAINT\s+',
    re.IGNORECASE,
)


def maybe_make_idempotent(sql: str) -> str:
    """Make certain statements idempotent so the all-in-one script can build
    a fresh DB even when source migrations target drifted production state.

    Specifically: `ALTER TABLE ... RENAME CONSTRAINT old TO new` fails with
    `undefined_object` if `old` doesn't exist. Wrap in a DO block that
    swallows that single error class so the rename is a no-op on a fresh
    database (where the constraint was created with its post-rename name)
    while still applying on production databases (where the source name
    exists due to historic naming-strategy drift)."""
    if _RENAME_CONSTRAINT_RE.match(sql):
        inner = sql.replace("$$", "$$$$")  # escape any $$ inside (none in practice)
        return (
            "DO $$ BEGIN\n"
            f"  {inner};\n"
            "EXCEPTION WHEN undefined_object THEN NULL;\n"
            "END $$"
        )
    return sql


def _parse_create_table_columns(body: str) -> dict[str, str]:
    cols: dict[str, str] = {}
    for raw in _split_top_level_commas(body):
        part = raw.strip()
        upper = part.upper()
        if (
            upper.startswith("CONSTRAINT")
            or upper.startswith("PRIMARY KEY")
            or upper.startswith("UNIQUE")
            or upper.startswith("CHECK")
            or upper.startswith("FOREIGN KEY")
        ):
            continue
        m = _COLUMN_RE.match(part)
        if not m:
            continue
        col = m.group("col")
        type_name = m.group("qtype") or m.group("utype")
        if type_name is None:
            continue
        cols[col] = type_name
    return cols


def apply_sql_to_schema(sql: str, state: SchemaState) -> None:
    """Best-effort schema-state update from a single SQL statement (the
    statement is assumed terminator-free; we don't strip ';')."""
    s = sql.strip()

    m = _CREATE_TABLE_RE.match(s)
    if m:
        name = m.group("name") or _strip_ident(m.group(1))
        cols = _parse_create_table_columns(m.group("body"))
        state.add_table(name, cols)
        return

    m = _DROP_TABLE_RE.match(s)
    if m:
        state.drop_table(m.group("name"))
        return

    m = _CREATE_TYPE_RE.match(s)
    if m:
        state.add_type(m.group("name"))
        return

    m = _DROP_TYPE_RE.match(s)
    if m:
        state.drop_type(m.group("name"))
        return

    m = _ALTER_TYPE_RENAME_RE.match(s)
    if m:
        state.rename_type(m.group("old"), m.group("new"))
        return

    m = _ALTER_TABLE_RENAME_RE.match(s)
    if m:
        state.rename_table(m.group("old"), m.group("new"))
        return

    m = _ALTER_RENAME_COLUMN_RE.match(s)
    if m:
        state.rename_column(m.group("table"), m.group("old"), m.group("new"))
        return

    m = _ALTER_ADD_COL_RE.match(s)
    if m:
        type_name = m.group("qtype") or m.group("utype")
        state.add_column(m.group("table"), m.group("col"), type_name)
        return

    m = _ALTER_DROP_COL_RE.match(s)
    if m:
        state.drop_column(m.group("table"), m.group("col"))
        return

    m = _ALTER_COL_TYPE_RE.match(s)
    if m:
        type_name = m.group("qtype") or m.group("utype")
        state.set_column_type(m.group("table"), m.group("col"), type_name)
        return


# ---------------------------------------------------------------------------
# up() body extraction
# ---------------------------------------------------------------------------


def find_up_body(content: str) -> str | None:
    """Return the source text of the up() method body, between the outermost
    `{` and matching `}`. Tracks strings (single, double, backtick),
    template-literal `${...}` expressions, and comments so brace counting
    stays accurate."""
    sig = re.search(
        r"public\s+async\s+up\s*\(\s*queryRunner\s*:\s*QueryRunner\s*\)\s*:\s*Promise<void>\s*\{",
        content,
    )
    if not sig:
        return None

    i = sig.end()
    depth = 1
    state = "code"  # code | string_s | string_d | template | line_comment | block_comment
    template_brace_stack: list[int] = []  # depth saved on `${`

    while i < len(content) and depth > 0:
        c = content[i]
        nxt = content[i + 1] if i + 1 < len(content) else ""

        if state == "code":
            if c == "/" and nxt == "/":
                state = "line_comment"
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block_comment"
                i += 2
                continue
            if c == "'":
                state = "string_s"
            elif c == '"':
                state = "string_d"
            elif c == "`":
                state = "template"
            elif c == "{":
                depth += 1
            elif c == "}":
                if template_brace_stack and depth == template_brace_stack[-1]:
                    template_brace_stack.pop()
                    depth -= 1
                    state = "template"
                else:
                    depth -= 1
                    if depth == 0:
                        return content[sig.end() : i]
        elif state == "string_s":
            if c == "\\":
                i += 2
                continue
            if c == "'":
                state = "code"
        elif state == "string_d":
            if c == "\\":
                i += 2
                continue
            if c == '"':
                state = "code"
        elif state == "template":
            if c == "\\":
                i += 2
                continue
            if c == "`":
                state = "code"
            elif c == "$" and nxt == "{":
                template_brace_stack.append(depth + 1)
                depth += 1
                state = "code"
                i += 2
                continue
        elif state == "line_comment":
            if c == "\n":
                state = "code"
        elif state == "block_comment":
            if c == "*" and nxt == "/":
                state = "code"
                i += 2
                continue

        i += 1

    return None


# ---------------------------------------------------------------------------
# queryRunner.query() extraction
# ---------------------------------------------------------------------------


QUERY_CALL_RE = re.compile(r"queryRunner\s*\.\s*query\s*\(")
HELPER_CALL_RE = re.compile(
    r"queryRunner\s*\.\s*(?P<name>query|renameTable|renameColumn|dropColumn)\s*\("
)


def parse_template_literal(text: str, start: int) -> tuple[str, int]:
    """Parse a template literal starting at text[start] == '`'. Returns
    (raw_inner_text_including_${expr}, index_after_closing_backtick)."""
    assert text[start] == "`"
    i = start + 1
    out: list[str] = []
    while i < len(text):
        c = text[i]
        if c == "\\":
            # preserve escape, advance by two
            out.append(text[i : i + 2])
            i += 2
            continue
        if c == "`":
            return "".join(out), i + 1
        if c == "$" and i + 1 < len(text) and text[i + 1] == "{":
            # capture full ${...} respecting nested braces / strings
            j = i + 2
            depth = 1
            inner_start = j
            while j < len(text) and depth > 0:
                cj = text[j]
                if cj == "{":
                    depth += 1
                elif cj == "}":
                    depth -= 1
                    if depth == 0:
                        break
                elif cj in ("'", '"', "`"):
                    # skip string
                    quote = cj
                    j += 1
                    while j < len(text) and text[j] != quote:
                        if text[j] == "\\":
                            j += 2
                            continue
                        j += 1
                j += 1
            expr = text[inner_start:j]
            out.append("${" + expr + "}")
            i = j + 1
            continue
        out.append(c)
        i += 1
    raise ValueError("unterminated template literal")


def parse_arg_list(text: str, start: int) -> tuple[list[str], int]:
    """Parse the comma-separated arguments of a call expression starting at
    text[start] = `(`. Returns (list_of_arg_source_strings, index_after_`)`)."""
    assert text[start] == "("
    i = start + 1
    args: list[str] = []
    current: list[str] = []
    depth_paren = 0
    depth_bracket = 0
    depth_brace = 0
    state = "code"

    def flush() -> None:
        arg = "".join(current).strip()
        if arg:
            args.append(arg)
        current.clear()

    while i < len(text):
        c = text[i]
        nxt = text[i + 1] if i + 1 < len(text) else ""
        if state == "code":
            if c == "'":
                state = "string_s"
                current.append(c)
            elif c == '"':
                state = "string_d"
                current.append(c)
            elif c == "`":
                # consume whole template literal including ${...}
                raw, end = parse_template_literal(text, i)
                current.append("`" + raw + "`")
                i = end
                continue
            elif c == "(":
                depth_paren += 1
                current.append(c)
            elif c == ")":
                if depth_paren == 0 and depth_bracket == 0 and depth_brace == 0:
                    flush()
                    return args, i + 1
                depth_paren -= 1
                current.append(c)
            elif c == "[":
                depth_bracket += 1
                current.append(c)
            elif c == "]":
                depth_bracket -= 1
                current.append(c)
            elif c == "{":
                depth_brace += 1
                current.append(c)
            elif c == "}":
                depth_brace -= 1
                current.append(c)
            elif (
                c == ","
                and depth_paren == 0
                and depth_bracket == 0
                and depth_brace == 0
            ):
                flush()
            else:
                current.append(c)
        elif state == "string_s":
            current.append(c)
            if c == "\\":
                current.append(nxt)
                i += 2
                continue
            if c == "'":
                state = "code"
        elif state == "string_d":
            current.append(c)
            if c == "\\":
                current.append(nxt)
                i += 2
                continue
            if c == '"':
                state = "code"
        i += 1
    raise ValueError("unterminated argument list")


# ---------------------------------------------------------------------------
# Interpolation + param resolution
# ---------------------------------------------------------------------------


def resolve_interpolation(expr: str) -> str:
    """Resolve a ${...} expression to its runtime string value, using the
    CONSTANTS table. Raises if unknown."""
    key = expr.strip()
    if key in CONSTANTS:
        return CONSTANTS[key]
    raise KeyError(f"unresolved interpolation: ${{{key}}}")


def render_template_literal(raw: str) -> str:
    """Substitute all ${...} occurrences in a raw template-literal body."""
    out: list[str] = []
    i = 0
    while i < len(raw):
        c = raw[i]
        if c == "\\" and i + 1 < len(raw):
            # ` template-literal escape: keep the escaped char as-is
            out.append(raw[i + 1])
            i += 2
            continue
        if c == "$" and raw[i + 1 : i + 2] == "{":
            # find matching }
            depth = 1
            j = i + 2
            while j < len(raw) and depth > 0:
                if raw[j] == "{":
                    depth += 1
                elif raw[j] == "}":
                    depth -= 1
                    if depth == 0:
                        break
                j += 1
            expr = raw[i + 2 : j]
            out.append(resolve_interpolation(expr))
            i = j + 1
            continue
        out.append(c)
        i += 1
    return "".join(out)


JS_STRING_ARRAY_RE = re.compile(
    r"^\[\s*((?:'[^']*'\s*,\s*)*'[^']*')\s*\]$"
)


def js_literal_to_pg(js: str) -> str:
    """Convert a JS literal expression (used in `, [param1, param2]`) into
    its PostgreSQL textual representation. Supports:
      - single-quoted strings → PG single-quoted strings (escape ')
      - arrays of single-quoted strings → ARRAY['a','b']
      - integer / float literals → unchanged
      - boolean literals → TRUE/FALSE
      - NULL/undefined → NULL"""
    s = js.strip()
    if s in ("null", "undefined"):
        return "NULL"
    if s in ("true", "false"):
        return s.upper()
    # plain number
    if re.fullmatch(r"-?\d+(\.\d+)?", s):
        return s
    # single-quoted string
    if s.startswith("'") and s.endswith("'") and len(s) >= 2:
        inner = s[1:-1].replace("\\'", "'").replace("''", "'")
        return "'" + inner.replace("'", "''") + "'"
    # double-quoted string
    if s.startswith('"') and s.endswith('"') and len(s) >= 2:
        inner = s[1:-1]
        return "'" + inner.replace("'", "''") + "'"
    # array of single-quoted strings: ['a', 'b']
    m = JS_STRING_ARRAY_RE.match(s)
    if m:
        items = re.findall(r"'((?:[^'\\]|\\.)*)'", m.group(1))
        rendered = ",".join("'" + it.replace("'", "''") + "'" for it in items)
        return f"ARRAY[{rendered}]"
    raise ValueError(f"unsupported JS literal in params: {js!r}")


def substitute_params(sql: str, params_src: str) -> str:
    """Inline `, [a, b]` params into a SQL string by replacing $1, $2…"""
    # strip outer brackets
    inner = params_src.strip()
    if not (inner.startswith("[") and inner.endswith("]")):
        raise ValueError(f"unexpected params shape: {params_src!r}")
    inner = inner[1:-1]
    # split top-level commas (respect quotes and brackets)
    parts: list[str] = []
    current: list[str] = []
    depth_bracket = 0
    depth_paren = 0
    state = "code"
    i = 0
    while i < len(inner):
        c = inner[i]
        if state == "code":
            if c == "'":
                state = "string_s"
                current.append(c)
            elif c == '"':
                state = "string_d"
                current.append(c)
            elif c == "[":
                depth_bracket += 1
                current.append(c)
            elif c == "]":
                depth_bracket -= 1
                current.append(c)
            elif c == "(":
                depth_paren += 1
                current.append(c)
            elif c == ")":
                depth_paren -= 1
                current.append(c)
            elif c == "," and depth_bracket == 0 and depth_paren == 0:
                parts.append("".join(current).strip())
                current.clear()
            else:
                current.append(c)
        elif state == "string_s":
            current.append(c)
            if c == "\\" and i + 1 < len(inner):
                current.append(inner[i + 1])
                i += 2
                continue
            if c == "'":
                state = "code"
        elif state == "string_d":
            current.append(c)
            if c == "\\" and i + 1 < len(inner):
                current.append(inner[i + 1])
                i += 2
                continue
            if c == '"':
                state = "code"
        i += 1
    if current:
        parts.append("".join(current).strip())

    rendered = [js_literal_to_pg(p) for p in parts]

    def replacement(match: re.Match[str]) -> str:
        idx = int(match.group(1)) - 1
        if idx >= len(rendered):
            raise ValueError(f"missing param ${idx+1} for sql: {sql}")
        return rendered[idx]

    return re.sub(r"\$(\d+)", replacement, sql)


# ---------------------------------------------------------------------------
# Per-migration extraction
# ---------------------------------------------------------------------------


def is_inside_for_loop(body: str, query_offset: int) -> bool:
    """Return True iff body[query_offset] is inside a `for (...) { ... }`
    block. Heuristic: count `for (` opens vs matching `}` closes before
    query_offset, tracking brace depth."""
    depth = 0
    for_starts: list[int] = []
    i = 0
    state = "code"
    while i < query_offset:
        c = body[i]
        nxt = body[i + 1] if i + 1 < len(body) else ""
        if state == "code":
            if c == "/" and nxt == "/":
                state = "line"
                i += 2
                continue
            if c == "/" and nxt == "*":
                state = "block"
                i += 2
                continue
            if c == "'":
                state = "string_s"
            elif c == '"':
                state = "string_d"
            elif c == "`":
                # skip template literal
                _, end = parse_template_literal(body, i)
                i = end
                continue
            elif c == "{":
                depth += 1
            elif c == "}":
                if for_starts and depth == for_starts[-1]:
                    for_starts.pop()
                depth -= 1
            elif body.startswith("for", i) and re.match(
                r"^for\s*\(", body[i:]
            ):
                # consume up to opening `{`
                j = i + 3
                # skip the for header until matching `)`
                par_depth = 0
                while j < query_offset:
                    if body[j] == "(":
                        par_depth += 1
                    elif body[j] == ")":
                        par_depth -= 1
                        if par_depth == 0:
                            j += 1
                            break
                    j += 1
                # advance to `{`
                while j < query_offset and body[j] != "{":
                    j += 1
                if j < query_offset and body[j] == "{":
                    for_starts.append(depth)
                    depth += 1
                    i = j + 1
                    continue
        elif state == "line":
            if c == "\n":
                state = "code"
        elif state == "block":
            if c == "*" and nxt == "/":
                state = "code"
                i += 2
                continue
        elif state == "string_s":
            if c == "\\":
                i += 2
                continue
            if c == "'":
                state = "code"
        elif state == "string_d":
            if c == "\\":
                i += 2
                continue
            if c == '"':
                state = "code"
        i += 1
    return len(for_starts) > 0


def is_assigned_to_const(body: str, call_offset: int) -> bool:
    """True if the queryRunner.query(...) call is the RHS of `const x = await
    queryRunner.query(...)` — i.e. a read used by JS-side data backfill,
    not a schema change."""
    # walk backwards from call_offset to find the start of the statement
    j = call_offset - 1
    while j >= 0 and body[j] in " \t\n\r":
        j -= 1
    # expect `await`
    if not body[: j + 1].rstrip().endswith("await"):
        return False
    # before `await` should be `=`
    pre = body[: j + 1].rstrip()[:-5].rstrip()
    if not pre.endswith("="):
        return False
    # before `=` should contain `const ident`
    pre2 = pre[:-1].rstrip()
    return bool(re.search(r"\bconst\s+\w+\s*$", pre2))


def _parse_string_arg(arg: str) -> str:
    """Unquote a single-quoted JS string literal argument."""
    s = arg.strip()
    if s.startswith("'") and s.endswith("'") and len(s) >= 2:
        return s[1:-1].replace("\\'", "'")
    if s.startswith('"') and s.endswith('"') and len(s) >= 2:
        return s[1:-1].replace('\\"', '"')
    raise ValueError(f"expected string literal arg, got: {arg!r}")


def _expand_rename_table(old: str, new: str, state: SchemaState) -> list[str]:
    """Mirror TypeORM's renameTable: ALTER TABLE plus auto-rename of any
    enum types whose name follows the `<old>_<col>_enum` convention."""
    out = [f'ALTER TABLE "{old}" RENAME TO "{new}"']
    if old in state.tables:
        for col, type_name in list(state.tables[old].items()):
            expected = f"{old}_{col.lower()}_enum"
            if type_name == expected:
                new_type = f"{new}_{col.lower()}_enum"
                out.append(f'ALTER TYPE "{type_name}" RENAME TO "{new_type}"')
    return out


def _expand_rename_column(
    table: str, old: str, new: str, state: SchemaState
) -> list[str]:
    """Mirror TypeORM's renameColumn: ALTER TABLE RENAME COLUMN plus
    auto-rename of `<table>_<old>_enum` to `<table>_<new>_enum` if present."""
    out = [f'ALTER TABLE "{table}" RENAME COLUMN "{old}" TO "{new}"']
    current_type = state.column_type(table, old)
    expected = f"{table}_{old.lower()}_enum"
    if current_type == expected:
        new_type = f"{table}_{new.lower()}_enum"
        out.append(f'ALTER TYPE "{current_type}" RENAME TO "{new_type}"')
    return out


def extract_helper_statements(body: str) -> list[tuple[str, list[str], int]]:
    """Return [(call_kind, args, call_start_offset), ...] in source order.
    `call_kind` is one of: query | renameTable | renameColumn | dropColumn.
    `args` are the raw argument source strings."""
    items: list[tuple[str, list[str], int]] = []
    for m in HELPER_CALL_RE.finditer(body):
        kind = m.group("name")
        paren_open = m.end() - 1
        args, _ = parse_arg_list(body, paren_open)
        items.append((kind, args, m.start()))
    return items


def extract_queries(
    body: str,
    state: SchemaState,
) -> list[str]:
    """Return SQL statements to emit, in source order. Handles:
      - queryRunner.query(): template literal SQL, with interpolation +
        param substitution. Skips data-backfill loops and read-only probes.
      - queryRunner.renameTable(old, new): expands to ALTER TABLE + enum
        auto-rename.
      - queryRunner.renameColumn(table, old, new): same, for columns.
      - queryRunner.dropColumn(table, col): ALTER TABLE DROP COLUMN.
    Updates `state` as statements are produced."""
    out: list[str] = []
    for kind, args, call_start in extract_helper_statements(body):
        if kind == "query":
            if not args:
                continue
            first = args[0].strip()
            if not (first.startswith("`") and first.endswith("`")):
                raise ValueError(
                    f"non-template-literal first arg to queryRunner.query: {first[:80]!r}"
                )
            raw_sql = first[1:-1]
            sql = render_template_literal(raw_sql).strip()
            if not sql:
                continue
            has_params = len(args) > 1
            in_loop = is_inside_for_loop(body, call_start)
            in_const_read = is_assigned_to_const(body, call_start)
            if has_params:
                if in_loop:
                    continue
                sql = substitute_params(sql, args[1])
            if in_const_read and sql.upper().startswith("SELECT"):
                continue
            apply_sql_to_schema(sql, state)
            out.append(sql)
        elif kind == "renameTable":
            if len(args) < 2:
                raise ValueError(f"renameTable expects 2 args, got {args}")
            old = _parse_string_arg(args[0])
            new = _parse_string_arg(args[1])
            for stmt in _expand_rename_table(old, new, state):
                apply_sql_to_schema(stmt, state)
                out.append(stmt)
        elif kind == "renameColumn":
            if len(args) < 3:
                raise ValueError(f"renameColumn expects 3 args, got {args}")
            table = _parse_string_arg(args[0])
            old = _parse_string_arg(args[1])
            new = _parse_string_arg(args[2])
            for stmt in _expand_rename_column(table, old, new, state):
                apply_sql_to_schema(stmt, state)
                out.append(stmt)
        elif kind == "dropColumn":
            if len(args) < 2:
                raise ValueError(f"dropColumn expects 2 args, got {args}")
            table = _parse_string_arg(args[0])
            col = _parse_string_arg(args[1])
            stmt = f'ALTER TABLE "{table}" DROP COLUMN "{col}"'
            apply_sql_to_schema(stmt, state)
            out.append(stmt)
    return out


# ---------------------------------------------------------------------------
# Discovery + ordering
# ---------------------------------------------------------------------------


def collect_migrations() -> list[tuple[int, Path, str]]:
    """Return (timestamp, path, folder_tag) for every migration file."""
    result: list[tuple[int, Path, str]] = []
    for path in MIGRATIONS_DIR.glob("*-migration.ts"):
        ts = int(path.stem.split("-")[0])
        result.append((ts, path, "legacy"))
    for path in (MIGRATIONS_DIR / "pre-deploy").glob("*-migration.ts"):
        ts = int(path.stem.split("-")[0])
        result.append((ts, path, "pre-deploy"))
    for path in (MIGRATIONS_DIR / "post-deploy").glob("*-migration.ts"):
        ts = int(path.stem.split("-")[0])
        result.append((ts, path, "post-deploy"))
    result.sort(key=lambda x: (x[0], x[1].name))
    return result


def main() -> int:
    migrations = collect_migrations()
    if not migrations:
        print(f"no migrations found under {MIGRATIONS_DIR}", file=sys.stderr)
        return 1

    out: list[str] = []
    out.append("--")
    out.append("-- apps/api merged schema (TypeORM migrations -> single SQL)")
    out.append("-- Generated by apps/infra-local/scripts/build-all-in-one-sql.py")
    out.append("-- Do not edit by hand; regenerate from migrations instead.")
    out.append("--")
    out.append(f"-- Migrations consolidated: {len(migrations)}")
    out.append("--")
    out.append("")
    out.append("-- Required for uuid_generate_v4()")
    out.append('CREATE EXTENSION IF NOT EXISTS "uuid-ossp";')
    out.append("")
    out.append("BEGIN;")
    out.append("")
    out.append("-- TypeORM migrations tracking table (auto-created on first run,")
    out.append("-- created explicitly here so we can pre-populate it at the end).")
    out.append('CREATE TABLE IF NOT EXISTS "migrations" (')
    out.append('  "id" SERIAL NOT NULL,')
    out.append('  "timestamp" bigint NOT NULL,')
    out.append('  "name" character varying NOT NULL,')
    out.append('  CONSTRAINT "PK_migrations_id" PRIMARY KEY ("id")')
    out.append(");")
    out.append("")

    total_queries = 0
    inserted_migrations: list[tuple[int, str]] = []
    failures: list[tuple[Path, BaseException]] = []
    state = SchemaState()

    for ts, path, folder in migrations:
        try:
            content = path.read_text()
            cls = CLASS_NAME_RE.search(content)
            class_name = cls.group(1) if cls else f"Migration{ts}"
            body = find_up_body(content)
            if body is None:
                raise ValueError("could not find up() body")
            queries = extract_queries(body, state)
        except BaseException as exc:  # noqa: BLE001
            failures.append((path, exc))
            continue

        rel = path.relative_to(REPO_ROOT)
        out.append(f"-- ---------------------------------------------------------------------------")
        out.append(f"-- {rel}  ({folder}, timestamp={ts}, queries={len(queries)})")
        out.append(f"-- ---------------------------------------------------------------------------")
        for q in queries:
            out.append(f"{maybe_make_idempotent(q)};")
            out.append("")
        total_queries += len(queries)
        inserted_migrations.append((ts, class_name))

    if failures:
        for path, exc in failures:
            print(f"FAIL {path}: {exc}", file=sys.stderr)
        return 2

    out.append("-- ---------------------------------------------------------------------------")
    out.append("-- Pre-populate the migrations tracking table so `npm run migration:run`")
    out.append("-- is a no-op against a database created from this all-in-one script.")
    out.append("-- ---------------------------------------------------------------------------")
    for ts, name in inserted_migrations:
        out.append(
            f'INSERT INTO "migrations" ("timestamp", "name") VALUES ({ts}, \'{name}\');'
        )
    out.append("")
    out.append("COMMIT;")
    out.append("")

    OUTPUT_FILE.write_text("\n".join(out))
    print(
        f"wrote {OUTPUT_FILE} ({len(migrations)} migrations, {total_queries} statements)"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
