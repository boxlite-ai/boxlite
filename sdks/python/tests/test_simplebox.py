"""Integration tests for the async SimpleBox convenience wrapper."""

from __future__ import annotations

import pytest

import boxlite

pytestmark = [pytest.mark.integration, pytest.mark.asyncio]


async def test_simplebox_metrics(shared_runtime):
    """Async SimpleBox exposes box metrics like SyncSimpleBox."""
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await box.exec("echo", "test")
        metrics = await box.metrics()
        assert metrics is not None
        assert metrics.commands_executed_total >= 1


async def test_simplebox_info_is_awaitable(shared_runtime):
    """Async SimpleBox resolves box metadata through its native handle."""
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        info = await box.info()
        assert info.id == box.id


async def _install_git_or_skip(box):
    installed = await box.exec("sh", "-c", "apk add --no-cache git")
    if installed.exit_code != 0:
        pytest.skip(f"apk add git failed: {installed.stderr}")


async def test_git_rejects_invalid_config_args(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        with pytest.raises(RuntimeError, match="path"):
            await box.git.set_config("user.email", "local@boxlite.ai", scope="local")
        with pytest.raises(RuntimeError, match="path"):
            await box.git.get_config("user.email", scope="local")
        with pytest.raises(RuntimeError, match="path"):
            await box.git.configure_user("BoxLite Bot", "bot@boxlite.ai", scope="local")
        with pytest.raises(RuntimeError, match="global"):
            await box.git.set_config("user.email", "x@boxlite.ai", scope="file")
        with pytest.raises(RuntimeError, match="global"):
            await box.git.get_config("user.email", scope="file")
        with pytest.raises(RuntimeError, match="global"):
            await box.git.configure_user("BoxLite Bot", "x@boxlite.ai", scope="file")


async def test_git_configure_user_writes_global_identity(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await _install_git_or_skip(box)
        await box.git.configure_user("BoxLite Bot", "bot@boxlite.ai")
        email = await box.exec("sh", "-c", "git config --global --get user.email")
        name = await box.exec("sh", "-c", "git config --global --get user.name")
        assert email.exit_code == 0, email.stderr
        assert name.exit_code == 0, name.stderr
        assert email.stdout.strip() == "bot@boxlite.ai"
        assert name.stdout.strip() == "BoxLite Bot"


async def test_git_commit_uses_configured_identity(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await _install_git_or_skip(box)
        await box.git.configure_user("BoxLite Bot", "bot@boxlite.ai")
        log = await box.exec(
            "sh",
            "-c",
            "set -e\n"
            "git init /tmp/repo\n"
            "echo hi > /tmp/repo/README\n"
            "git -C /tmp/repo add README\n"
            "git -C /tmp/repo -c commit.gpgsign=false commit -m init\n"
            "git -C /tmp/repo log -1 --format='%an <%ae>'\n",
        )
        assert log.exit_code == 0, log.stderr
        assert "BoxLite Bot <bot@boxlite.ai>" in log.stdout


async def test_git_local_config_does_not_change_global(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await _install_git_or_skip(box)
        await box.git.configure_user("BoxLite Bot", "bot@boxlite.ai")
        init = await box.exec("git", "init", "/tmp/repo")
        assert init.exit_code == 0, init.stderr
        await box.git.set_config(
            "user.email",
            "local@boxlite.ai",
            scope="local",
            path="/tmp/repo",
        )
        local = await box.exec(
            "sh", "-c", "git -C /tmp/repo config --local --get user.email"
        )
        global_email = await box.exec(
            "sh", "-c", "git config --global --get user.email"
        )
        assert local.exit_code == 0, local.stderr
        assert global_email.exit_code == 0, global_email.stderr
        assert local.stdout.strip() == "local@boxlite.ai"
        assert global_email.stdout.strip() == "bot@boxlite.ai"
        assert (
            await box.git.get_config("user.email", scope="local", path="/tmp/repo")
            == "local@boxlite.ai"
        )
        assert await box.git.get_config("user.email") == "bot@boxlite.ai"


async def test_git_get_config_reads_guest(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await _install_git_or_skip(box)
        written = await box.exec(
            "sh", "-c", "git config --global user.email other@boxlite.ai"
        )
        assert written.exit_code == 0, written.stderr
        assert await box.git.get_config("user.email") == "other@boxlite.ai"


async def test_git_status_and_branches_are_structured(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await _install_git_or_skip(box)
        await box.git.configure_user("BoxLite Bot", "bot@boxlite.ai")
        setup = await box.exec(
            "sh",
            "-c",
            "set -e\n"
            "git init -q -b main /tmp/origin\n"
            "echo hi > /tmp/origin/README.md\n"
            "git -C /tmp/origin add README.md\n"
            "git -C /tmp/origin -c commit.gpgsign=false commit -qm init\n"
            "git clone -q /tmp/origin /tmp/repo\n",
        )
        assert setup.exit_code == 0, setup.stderr

        st = await box.git.status("/tmp/repo")
        assert st.file_status == []
        assert st.current_branch == "main"
        assert st.upstream == "origin/main"
        assert (st.ahead, st.behind) == (0, 0)
        assert st.branch_published

        dirty = await box.exec(
            "sh",
            "-c",
            "set -e\n"
            "echo x >> /tmp/repo/README.md\n"
            "echo a > '/tmp/repo/with space.txt'\n"
            "printf b > \"/tmp/repo/line$(printf '\\nb')reak\"\n",
        )
        assert dirty.exit_code == 0, dirty.stderr
        st = await box.git.status("/tmp/repo")
        by_path = {f.path: f for f in st.file_status}
        assert by_path["README.md"].worktree_status == "M"
        assert by_path["with space.txt"].untracked
        assert "line\nbreak" in by_path

        commit = await box.exec(
            "sh",
            "-c",
            "git -C /tmp/repo -c commit.gpgsign=false commit -qam more"
            " && git -C /tmp/repo branch feature",
        )
        assert commit.exit_code == 0, commit.stderr
        st = await box.git.status("/tmp/repo")
        assert st.ahead == 1

        b = await box.git.branches("/tmp/repo")
        assert b.current == "main"
        assert sorted(b.names) == ["feature", "main"]


async def test_git_status_unborn_and_detached_head(shared_runtime):
    async with boxlite.SimpleBox(image="alpine:latest", runtime=shared_runtime) as box:
        await _install_git_or_skip(box)
        await box.git.configure_user("BoxLite Bot", "bot@boxlite.ai")
        init = await box.exec("git", "init", "-q", "-b", "trunk", "/tmp/repo")
        assert init.exit_code == 0, init.stderr

        st = await box.git.status("/tmp/repo")
        assert (st.current_branch, st.head_commit) == ("trunk", None)
        b = await box.git.branches("/tmp/repo")
        assert (b.current, b.names) == ("trunk", [])

        detach = await box.exec(
            "sh",
            "-c",
            "set -e\n"
            "git -C /tmp/repo -c commit.gpgsign=false commit -q --allow-empty -m one\n"
            "git -C /tmp/repo checkout -q --detach\n",
        )
        assert detach.exit_code == 0, detach.stderr
        st = await box.git.status("/tmp/repo")
        assert st.current_branch is None and st.head_commit
        b = await box.git.branches("/tmp/repo")
        assert (b.current, b.names) == (None, ["trunk"])
