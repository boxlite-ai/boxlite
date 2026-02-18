"""
SimpleBox - Foundation for specialized container types.

Provides common functionality for all specialized boxes (CodeBox, BrowserBox, etc.)
"""

import logging
from enum import IntEnum
from typing import Optional, TYPE_CHECKING

from .exec import ExecResult

if TYPE_CHECKING:
    from .boxlite import Boxlite

logger = logging.getLogger("boxlite.simplebox")

__all__ = ["SimpleBox"]


class StreamType(IntEnum):
    """Stream type for command execution output."""

    STDOUT = 1
    STDERR = 2


class SimpleBox:
    """
    Base class for specialized container types.

    This class encapsulates the common patterns:
    1. Async context manager support
    2. Automatic runtime lifecycle management
    3. Stdio blocking mode restoration

    Subclasses should override:
    - _create_box_options(): Return BoxOptions for their specific use case
    - Add domain-specific methods (e.g., CodeBox.run(), BrowserBox.navigate())
    """

    def __init__(
        self,
        image: Optional[str] = None,
        rootfs_path: Optional[str] = None,
        memory_mib: Optional[int] = None,
        cpus: Optional[int] = None,
        runtime: Optional["Boxlite"] = None,
        name: Optional[str] = None,
        auto_remove: bool = True,
        reuse_existing: bool = False,
        **kwargs,
    ):
        """
        Create a specialized box.

        Args:
            image: Container image to use (e.g., "python:3.12-slim")
            rootfs_path: Path to local OCI layout directory (overrides image if provided)
            memory_mib: Memory limit in MiB
            cpus: Number of CPU cores
            runtime: Optional runtime instance (uses global default if None)
            name: Optional name for the box (must be unique)
            auto_remove: Remove box when stopped (default: True)
            reuse_existing: If True and a box with the given name already exists,
                reuse it instead of raising an error (default: False)
            **kwargs: Additional configuration options

        Note: The box is not actually created until entering the async context manager.
        Use `async with SimpleBox(...) as box:` to create and start the box.

        Either `image` or `rootfs_path` must be provided.
        """
        if not image and not rootfs_path:
            raise ValueError("Either 'image' or 'rootfs_path' must be provided")

        try:
            from .boxlite import Boxlite, BoxOptions
        except ImportError as e:
            raise ImportError(
                f"BoxLite native extension not found: {e}. "
                "Please install with: pip install boxlite"
            )

        # Use provided runtime or get Rust's global default
        if runtime is None:
            self._runtime = Boxlite.default()
        else:
            self._runtime = runtime

        # Store box options for deferred creation in __aenter__
        self._box_options = BoxOptions(
            image=image,
            rootfs_path=rootfs_path,
            cpus=cpus,
            memory_mib=memory_mib,
            auto_remove=auto_remove,
            **kwargs,
        )
        self._name = name
        self._reuse_existing = reuse_existing
        self._box = None
        self._started = False
        self._created: Optional[bool] = None

    async def __aenter__(self):
        """Async context manager entry - creates or reuses an existing box.

        This method is idempotent - calling it multiple times is safe.
        All initialization logic lives here; start() is just an alias.

        When a name is provided, attempts to get an existing box first.
        This enables persistence across sessions with auto_remove=False.
        """
        if self._started:
            return self
        if self._reuse_existing:
            self._box, self._created = await self._runtime.get_or_create(
                self._box_options, name=self._name
            )
        else:
            self._box = await self._runtime.create(self._box_options, name=self._name)
            self._created = True
        await self._box.__aenter__()
        self._started = True
        return self

    async def start(self):
        """
        Explicitly create and start the box.

        Alternative to using context manager. Allows::

            box = SimpleBox(image="alpine:latest")
            await box.start()
            await box.exec("echo", "hello")

        Returns:
            self for method chaining
        """
        return await self.__aenter__()

    async def __aexit__(self, exc_type, exc_val, exc_tb):
        """Async context manager exit - delegates to Box.__aexit__ (returns awaitable)."""
        return await self._box.__aexit__(exc_type, exc_val, exc_tb)

    @property
    def id(self) -> str:
        """Get the box ID."""
        if not self._started:
            raise RuntimeError(
                "Box not started. Use 'async with SimpleBox(...) as box:' "
                "or call 'await box.start()' first."
            )
        return self._box.id

    def info(self):
        """Get box information."""
        if not self._started:
            raise RuntimeError(
                "Box not started. Use 'async with SimpleBox(...) as box:' "
                "or call 'await box.start()' first."
            )
        return self._box.info()

    @property
    def created(self) -> Optional[bool]:
        """Whether this box was newly created (True) or an existing box was reused (False).

        Returns None if the box hasn't been started yet.
        """
        return self._created

    async def exec(
        self,
        cmd: str,
        *args: str,
        env: Optional[dict[str, str]] = None,
    ) -> ExecResult:
        """
        Execute a command in the box and return the result.

        Args:
            cmd: Command to execute (e.g., 'ls', 'python')
            *args: Arguments to the command (e.g., '-l', '-a')
            env: Environment variables (default: guest's default environment)

        Returns:
            ExecResult with exit_code and output

        Examples:
            Simple execution::

                result = await box.exec('ls', '-l', '-a')
                print(f"Exit code: {result.exit_code}")
                print(f"Stdout: {result.stdout}")
                print(f"Stderr: {result.stderr}")

            With environment variables::

                result = await box.exec('env', env={'FOO': 'bar'})
                print(result.stdout)
        """
        if not self._started:
            raise RuntimeError(
                "Box not started. Use 'async with SimpleBox(...) as box:' "
                "or call 'await box.start()' first."
            )

        arg_list = list(args) if args else None
        # Convert env dict to list of tuples if provided
        env_list = list(env.items()) if env else None

        # Execute via Rust (returns PyExecution)
        execution = await self._box.exec(cmd, arg_list, env_list)

        # Get streams from Rust execution
        try:
            stdout = execution.stdout()
        except Exception as e:
            logger.error(f"take stdout err: {e}")
            stdout = None

        try:
            stderr = execution.stderr()
        except Exception as e:
            logger.error(f"take stderr err: {e}")
            stderr = None

        # Collect stdout and stderr separately
        stdout_lines = []
        stderr_lines = []

        # Read stdout
        if stdout:
            logger.debug("collecting stdout")
            try:
                async for line in stdout:
                    if isinstance(line, bytes):
                        stdout_lines.append(line.decode("utf-8", errors="replace"))
                    else:
                        stdout_lines.append(line)
            except Exception as e:
                logger.error(f"collecting stdout err: {e}")
                pass

        # Read stderr
        if stderr:
            logger.debug("collecting stderr")
            try:
                async for line in stderr:
                    if isinstance(line, bytes):
                        stderr_lines.append(line.decode("utf-8", errors="replace"))
                    else:
                        stderr_lines.append(line)
            except Exception as e:
                logger.error(f"collecting stderr err: {e}")
                pass

        # Combine lines
        stdout = "".join(stdout_lines)
        stderr = "".join(stderr_lines)

        error_message = None
        try:
            exec_result = await execution.wait()
            exit_code = exec_result.exit_code
            error_message = exec_result.error_message
        except Exception as e:
            logger.error(f"failed to wait execution: {e}")
            exit_code = -1

        logger.debug(f"exec finish, exit_code: {exit_code}")

        return ExecResult(
            exit_code=exit_code,
            stdout=stdout,
            stderr=stderr,
            error_message=error_message,
        )

    async def stop(self):
        """
        Stop the box and release resources.

        Note: Usually not needed as context manager handles cleanup.
        """
        if not self._started:
            raise RuntimeError(
                "Box not started. Use 'async with SimpleBox(...) as box:' "
                "or call 'await box.start()' first."
            )
        await self._box.stop()
        self._started = False

    async def shutdown(self):
        """
        Shutdown the box and release resources.

        Alias for stop(). Usually not needed as context manager handles cleanup.
        """
        await self.stop()

    async def copy_in(
        self,
        host_path: str,
        container_dest: str,
        *,
        overwrite: bool = True,
        follow_symlinks: bool = False,
        include_parent: bool = True,
    ) -> None:
        """
        Copy files/directories from host into the container.

        Args:
            host_path: Path on the host filesystem (file or directory)
            container_dest: Destination path inside the container
            overwrite: If True, overwrite existing files (default: True)
            follow_symlinks: If True, follow symlinks when copying (default: False)
            include_parent: If True, include parent directory in archive (default: True)

        Note:
            copy_in extracts files into the container rootfs layer. Destinations
            that are tmpfs mounts inside the guest (e.g. /tmp, /dev/shm) will
            silently fail — files land behind the mount and are invisible to
            running processes. This is the same limitation as ``docker cp``
            (see https://github.com/moby/moby/issues/22020).

            Workaround: use the low-level exec API to pipe a tar archive
            into the container (like ``docker exec -i CONTAINER tar xf -``)::

                execution = await box._box.exec("tar", args=["xf", "-", "-C", "/tmp"])
                stdin = execution.stdin()
                await stdin.send_input(tar_bytes)
                await stdin.close()
                result = await execution.wait()

        Examples:
            Copy a single file::

                await box.copy_in("/local/config.json", "/app/config.json")

            Copy a directory::

                await box.copy_in("/local/data/", "/app/data/")
        """
        if not self._started:
            raise RuntimeError(
                "Box not started. Use 'async with SimpleBox(...) as box:' "
                "or call 'await box.start()' first."
            )

        from .boxlite import CopyOptions

        opts = CopyOptions(
            recursive=True,
            overwrite=overwrite,
            follow_symlinks=follow_symlinks,
            include_parent=include_parent,
        )
        await self._box.copy_in(host_path, container_dest, opts)

    async def copy_out(
        self,
        container_src: str,
        host_dest: str,
        *,
        overwrite: bool = True,
        follow_symlinks: bool = False,
        include_parent: bool = True,
    ) -> None:
        """
        Copy files/directories from container to host.

        Args:
            container_src: Source path inside the container (file or directory)
            host_dest: Destination path on the host filesystem
            overwrite: If True, overwrite existing files (default: True)
            follow_symlinks: If True, follow symlinks when copying (default: False)
            include_parent: If True, include parent directory in archive (default: True)

        Examples:
            Copy a single file::

                await box.copy_out("/app/output.log", "/local/output.log")

            Copy a directory::

                await box.copy_out("/app/results/", "/local/results/")
        """
        if not self._started:
            raise RuntimeError(
                "Box not started. Use 'async with SimpleBox(...) as box:' "
                "or call 'await box.start()' first."
            )

        from .boxlite import CopyOptions

        opts = CopyOptions(
            recursive=True,
            overwrite=overwrite,
            follow_symlinks=follow_symlinks,
            include_parent=include_parent,
        )
        await self._box.copy_out(container_src, host_dest, opts)
