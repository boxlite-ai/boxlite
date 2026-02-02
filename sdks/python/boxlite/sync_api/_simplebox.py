"""
SyncSimpleBox - Synchronous wrapper for SimpleBox.

Provides a synchronous API for box operations.
API mirrors async SimpleBox exactly.
"""

from typing import TYPE_CHECKING, Dict, Optional

from ..exec import ExecResult

if TYPE_CHECKING:
    from ._boxlite import SyncBoxlite
    from ._box import SyncBox

__all__ = ["SyncSimpleBox"]


class SyncSimpleBox:
    """
    Synchronous wrapper for SimpleBox.

    Provides synchronous methods for executing commands in a BoxLite container.
    Uses SyncBox internally which handles async bridging via greenlet.
    API mirrors async SimpleBox exactly.

    Usage (standalone - recommended):
        with SyncSimpleBox(image="python:slim") as box:
            result = box.exec("ls", "-la")
            print(result.stdout)

    Usage (with explicit runtime):
        with SyncBoxlite.default() as runtime:
            with SyncSimpleBox(image="python:slim", runtime=runtime) as box:
                result = box.exec("ls", "-la")
                print(result.stdout)
    """

    def __init__(
        self,
        image: Optional[str] = None,
        rootfs_path: Optional[str] = None,
        memory_mib: Optional[int] = None,
        cpus: Optional[int] = None,
        runtime: Optional["SyncBoxlite"] = None,
        name: Optional[str] = None,
        auto_remove: bool = True,
        reuse_existing: bool = False,
        **kwargs,
    ):
        """
        Create a SyncSimpleBox.

        Args:
            image: Container image to use (e.g., "python:slim", "ubuntu:latest")
            rootfs_path: Path to local OCI layout directory (overrides image if provided)
            memory_mib: Memory limit in MiB (default: system default)
            cpus: Number of CPU cores (default: system default)
            runtime: Optional SyncBoxlite runtime. If None, creates default runtime.
            name: Optional unique name for the box
            auto_remove: Remove box when stopped (default: True)
            reuse_existing: If True and a box with the given name already exists,
                reuse it instead of raising an error (default: False)
            **kwargs: Additional BoxOptions parameters

        Either `image` or `rootfs_path` must be provided.
        """
        if not image and not rootfs_path:
            raise ValueError("Either 'image' or 'rootfs_path' must be provided")

        from ._boxlite import SyncBoxlite
        from ..boxlite import BoxOptions

        # Handle optional runtime
        if runtime is None:
            runtime = SyncBoxlite.default()
            self._owns_runtime = True
        else:
            self._owns_runtime = False

        self._runtime = runtime

        # Create box options
        self._box_opts = BoxOptions(
            image=image,
            rootfs_path=rootfs_path,
            cpus=cpus,
            memory_mib=memory_mib,
            auto_remove=auto_remove,
            **kwargs,
        )

        # Store for lazy creation in __enter__
        self._name = name
        self._reuse_existing = reuse_existing
        self._box: Optional["SyncBox"] = None
        self._created: Optional[bool] = None

    def __enter__(self) -> "SyncSimpleBox":
        """Enter context - starts runtime if owned, then starts the box."""
        # Start runtime if we own it
        if self._owns_runtime:
            self._runtime.start()

        # Create or reuse box via runtime
        if self._reuse_existing:
            self._box, self._created = self._runtime.get_or_create(
                self._box_opts, name=self._name
            )
        else:
            self._box = self._runtime.create(self._box_opts, name=self._name)
            self._created = True
        return self

    def __exit__(self, exc_type, exc_val, exc_tb) -> None:
        """Exit context - stops the box, then stops runtime if owned."""
        # Stop the box (SyncBox.stop() is already sync)
        if self._box is not None:
            self._box.stop()

        # Stop runtime if we own it
        if self._owns_runtime:
            self._runtime.stop()

    @property
    def id(self) -> str:
        """Get the box ID."""
        return self._box.id

    @property
    def name(self) -> Optional[str]:
        """Get the box name (if set)."""
        return self._box.name

    @property
    def created(self) -> Optional[bool]:
        """Whether this box was newly created (True) or an existing box was reused (False).

        Returns None if the box hasn't been started yet.
        """
        return self._created

    def info(self):
        """Get box information."""
        return self._box.info()

    def exec(
        self,
        cmd: str,
        *args: str,
        env: Optional[Dict[str, str]] = None,
    ) -> ExecResult:
        """
        Execute a command in the box synchronously.

        Args:
            cmd: Command to run (e.g., "ls", "python")
            *args: Command arguments (e.g., "-l", "-a")
            env: Environment variables as dict

        Returns:
            ExecResult with exit_code, stdout, and stderr

        Example:
            result = box.exec("ls", "-la")
            print(f"Exit code: {result.exit_code}")
            print(f"Output: {result.stdout}")
        """
        # Convert args to list format expected by SyncBox
        arg_list = list(args) if args else None
        env_list = list(env.items()) if env else None

        # SyncBox.exec() returns SyncExecution - already sync!
        execution = self._box.exec(cmd, arg_list, env_list)

        # Collect stdout (sync iteration)
        stdout_lines = []
        for line in execution.stdout():
            if isinstance(line, bytes):
                stdout_lines.append(line.decode("utf-8", errors="replace"))
            else:
                stdout_lines.append(line)

        # Collect stderr (sync iteration)
        stderr_lines = []
        for line in execution.stderr():
            if isinstance(line, bytes):
                stderr_lines.append(line.decode("utf-8", errors="replace"))
            else:
                stderr_lines.append(line)

        # Wait for completion (sync)
        result = execution.wait()

        return ExecResult(
            exit_code=result.exit_code,
            stdout="".join(stdout_lines),
            stderr="".join(stderr_lines),
            error_message=result.error_message,
        )

    def stop(self) -> None:
        """Stop the box (preserves state for restart)."""
        self._box.stop()

    def metrics(self):
        """Get box metrics (CPU, memory usage)."""
        return self._box.metrics()
