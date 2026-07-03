"""Real-world usage scenario tests over REST.

These test what a typical developer/AI agent actually does with boxlite:
multi-step workflows, running real programs, installing packages, writing
and executing scripts, network access, etc.

Each test mimics a realistic user session rather than testing a single
API parameter in isolation.
"""
from __future__ import annotations

import asyncio
import tempfile
from pathlib import Path

import boxlite
import pytest

from conftest import drain


# ── Write and run a Python script ──────────────────────────────────


@pytest.mark.asyncio
async def test_write_and_run_python_script(box):
    """User writes a Python script into the box and runs it."""
    script = (
        "import json, sys\n"
        "data = {'status': 'ok', 'numbers': list(range(5))}\n"
        "json.dump(data, sys.stdout)\n"
    )
    # Write the script
    ex = await box.exec(
        "sh", ["-c", f"cat > /root/test.py << 'PYEOF'\n{script}PYEOF"],
    )
    await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"writing script failed: rc={rc.exit_code}"

    # Run it
    ex = await box.exec("python3", ["/root/test.py"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0, f"python3 failed: rc={rc.exit_code}"
    assert '"status": "ok"' in out, f"script output wrong: {out!r}"
    assert '"numbers": [0, 1, 2, 3, 4]' in out


# ── Write and run a shell script ──────────────────────────────────


@pytest.mark.asyncio
async def test_write_and_run_shell_script(box):
    """User creates a shell script, makes it executable, runs it."""
    ex = await box.exec(
        "sh", ["-c",
               'cat > /root/greet.sh << \'EOF\'\n'
               '#!/bin/sh\n'
               'NAME="${1:-World}"\n'
               'echo "Hello, ${NAME}! Today is $(date +%A)."\n'
               'EOF\n'
               'chmod +x /root/greet.sh'],
    )
    await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0

    ex = await box.exec("/root/greet.sh", ["BoxliteUser"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "Hello, BoxliteUser!" in out, f"script output: {out!r}"


# ── Multi-step data pipeline ──────────────────────────────────────


@pytest.mark.asyncio
async def test_data_processing_pipeline(box):
    """User creates a CSV, processes it with awk, verifies result."""
    # Step 1: Create CSV data
    csv_data = "name,score\\nAlice,85\\nBob,92\\nCharlie,78\\nDiana,95"
    ex = await box.exec(
        "sh", ["-c", f'printf "{csv_data}" > /root/scores.csv'],
    )
    await drain(ex)
    await asyncio.wait_for(ex.wait(), timeout=30)

    # Step 2: Process with awk — compute average score
    ex = await box.exec(
        "sh", ["-c",
               "awk -F, 'NR>1 {sum+=$2; n++} END {printf \"avg=%.1f n=%d\\n\", sum/n, n}' "
               "/root/scores.csv"],
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "avg=87.5" in out, f"awk output wrong: {out!r}"
    assert "n=4" in out

    # Step 3: Find top scorer with sort
    ex = await box.exec(
        "sh", ["-c",
               "tail -n+2 /root/scores.csv | sort -t, -k2 -rn | head -1"],
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "Diana" in out, f"top scorer wrong: {out!r}"


# ── pip install and use a package ──────────────────────────────────


@pytest.mark.asyncio
async def test_pip_install_and_use(box):
    """User installs a Python package via pip and uses it.
    Uses a small stdlib-only validation to avoid network dependency
    for the install itself."""
    # Use Python's built-in modules to simulate a real workflow
    ex = await box.exec(
        "python3", ["-c",
                    "import hashlib, base64; "
                    "h = hashlib.sha256(b'boxlite-e2e').hexdigest(); "
                    "b = base64.b64encode(b'boxlite-e2e').decode(); "
                    "print(f'SHA256={h}'); "
                    "print(f'BASE64={b}')"],
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    assert rc.exit_code == 0
    assert "SHA256=" in out
    assert "BASE64=Ym94bGl0ZS1lMmU=" in out, f"base64 wrong: {out!r}"


# ── Git-like workflow: init, add, commit ───────────────────────────


@pytest.mark.asyncio
async def test_git_workflow(box):
    """User initialises a git repo, adds a file, commits."""
    cmds = (
        "cd /root && "
        "git init myproject 2>&1 && "
        "cd myproject && "
        "echo 'print(\"hello\")' > main.py && "
        "git add main.py && "
        "git -c user.email=e2e@test -c user.name=E2E commit -m 'init' 2>&1 && "
        "git log --oneline"
    )
    ex = await box.exec("sh", ["-c", cmds])
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    # git may not be installed; skip gracefully
    if rc.exit_code != 0 and "git" in (out + err).lower() and "not found" in (out + err).lower():
        pytest.skip("git not installed in base image")
    assert rc.exit_code == 0, f"git workflow failed: rc={rc.exit_code}\n{out}"
    assert "init" in out, f"commit not in log: {out!r}"


# ── File upload → process → download ──────────────────────────────


@pytest.mark.asyncio
async def test_upload_process_download(box):
    """User uploads a text file, processes it inside the box, downloads
    the result — a typical AI agent workflow."""
    # Upload input
    input_text = "the quick brown fox\njumps over the lazy dog\n"
    with tempfile.TemporaryDirectory() as tmpdir:
        src = Path(tmpdir) / "input.txt"
        src.write_text(input_text)
        await box.copy_in(str(src), "/root/input.txt")

    # Process: uppercase + word count
    ex = await box.exec(
        "sh", ["-c",
               "tr '[:lower:]' '[:upper:]' < /root/input.txt > /root/upper.txt && "
               "wc -w < /root/input.txt | tr -d ' ' > /root/count.txt"],
    )
    await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0

    # Download results
    with tempfile.TemporaryDirectory() as tmpdir:
        await box.copy_out("/root/upper.txt", str(Path(tmpdir) / "upper.txt"))
        await box.copy_out("/root/count.txt", str(Path(tmpdir) / "count.txt"))

        upper = (Path(tmpdir) / "upper.txt").read_text()
        count = (Path(tmpdir) / "count.txt").read_text().strip()

    assert "THE QUICK BROWN FOX" in upper, f"uppercase wrong: {upper!r}"
    assert count == "9", f"word count wrong: {count!r}"


# ── Compile and run C program ─────────────────────────────────────


@pytest.mark.asyncio
async def test_compile_and_run_c(box):
    """User writes, compiles, and runs a C program."""
    c_code = (
        '#include <stdio.h>\\n'
        'int main() {\\n'
        '    for (int i = 0; i < 5; i++) printf("i=%d\\\\n", i);\\n'
        '    return 0;\\n'
        '}\\n'
    )
    ex = await box.exec(
        "sh", ["-c",
               f'printf "{c_code}" > /root/test.c && '
               "gcc -o /root/test /root/test.c && "
               "/root/test"],
    )
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=60)
    # gcc may not be installed
    if rc.exit_code != 0 and "gcc" in (out + err).lower() and "not found" in (out + err).lower():
        pytest.skip("gcc not installed in base image")
    assert rc.exit_code == 0, f"compile+run failed: rc={rc.exit_code}\n{out}\n{err}"
    for i in range(5):
        assert f"i={i}" in out, f"missing i={i} in output: {out!r}"


# ── Network access: curl ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_network_curl(box):
    """User curls an external URL — verifies guest network works."""
    ex = await box.exec(
        "sh", ["-c",
               "curl -fsS --max-time 10 -o /dev/null -w '%{http_code}' "
               "https://httpbin.org/get 2>/dev/null || "
               "wget -q --timeout=10 -O /dev/null https://httpbin.org/get 2>&1 && echo 200"],
    )
    out, err = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    # Network may not be available in the guest; skip gracefully
    if rc.exit_code != 0:
        pytest.skip(f"network not available in guest: {err}")
    assert "200" in out, f"unexpected HTTP status: {out!r}"


# ── Process management: background + kill ──────────────────────────


@pytest.mark.asyncio
async def test_process_listing_and_kill(box):
    """User lists processes, finds one, and verifies kill works.

    Rather than starting a background process (which is tricky with
    exec stream semantics), test process tools on a known process."""
    # ps should work and list processes
    ex = await box.exec("ps", ["aux"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=10)
    assert rc.exit_code == 0
    assert "PID" in out or "pid" in out, f"ps output not valid: {out!r}"

    # Start a process, kill it, and prove it is actually gone: `kill -0`
    # after the wait must fail (no such pid), so ALIVE is never printed.
    ex = await box.exec(
        "sh", ["-c",
               "sleep 999 & SPID=$! && "
               "kill $SPID && "
               "wait $SPID 2>/dev/null; "
               "if kill -0 $SPID 2>/dev/null; then echo ALIVE; else echo KILLED; fi"],
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=10)
    assert "KILLED" in out and "ALIVE" not in out, f"process not terminated: {out!r}"


# ── Multi-user file permissions ────────────────────────────────────


@pytest.mark.asyncio
async def test_file_permissions_workflow(box):
    """User creates files with specific permissions and verifies them."""
    ex = await box.exec(
        "sh", ["-c",
               "echo secret > /root/private.txt && chmod 600 /root/private.txt && "
               "echo public > /root/public.txt && chmod 644 /root/public.txt && "
               "stat -c '%a %n' /root/private.txt /root/public.txt"],
    )
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "600" in out, f"private perms wrong: {out!r}"
    assert "644" in out, f"public perms wrong: {out!r}"


# ── Disk usage check ──────────────────────────────────────────────


@pytest.mark.asyncio
async def test_disk_and_memory_info(box):
    """User checks disk space and memory — common diagnostic workflow."""
    ex = await box.exec("sh", ["-c", "df -h / && free -m"])
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "Filesystem" in out or "Use%" in out, f"df output wrong: {out!r}"
    assert "Mem" in out or "total" in out, f"free output wrong: {out!r}"


# ── Python multi-file project ─────────────────────────────────────


@pytest.mark.asyncio
async def test_python_multifile_project(box):
    """User creates a multi-file Python project and runs it."""
    # Create project structure
    ex = await box.exec(
        "sh", ["-c",
               "mkdir -p /root/myapp && "
               "cat > /root/myapp/utils.py << 'EOF'\n"
               "def greet(name):\n"
               "    return f'Hello, {name}!'\n"
               "def add(a, b):\n"
               "    return a + b\n"
               "EOF\n"
               "cat > /root/myapp/main.py << 'EOF'\n"
               "from utils import greet, add\n"
               "print(greet('E2E'))\n"
               "print(f'sum={add(17, 25)}')\n"
               "EOF"],
    )
    await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0

    # Run the project
    ex = await box.exec("python3", ["/root/myapp/main.py"],
                        cwd="/root/myapp")
    out, _ = await drain(ex)
    rc = await asyncio.wait_for(ex.wait(), timeout=30)
    assert rc.exit_code == 0
    assert "Hello, E2E!" in out, f"greet wrong: {out!r}"
    assert "sum=42" in out, f"add wrong: {out!r}"
