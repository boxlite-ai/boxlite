"""
CodeBox - Secure Python code execution container.

Provides a simple, secure environment for running untrusted Python code.
"""

from typing import Optional, TYPE_CHECKING

from .simplebox import SimpleBox

if TYPE_CHECKING:
    from .boxlite import Boxlite


class CodeBox(SimpleBox):
    """
    Secure container for executing Python code.

    CodeBox provides an isolated environment for running untrusted Python code
    with built-in safety and result formatting.

    Usage:
        >>> async with CodeBox() as cb:
        ...     result = await cb.run("print('Hello, World!')")
    """

    def __init__(
        self,
        image: str = "python:slim",
        memory_mib: Optional[int] = None,
        cpus: Optional[int] = None,
        runtime: Optional["Boxlite"] = None,
        **kwargs,
    ):
        """
        Create a new CodeBox.

        Args:
            image: Container images with Python (default: python:slim)
            memory_mib: Memory limit in MiB (default: system default)
            cpus: Number of CPU cores (default: system default)
            runtime: Optional runtime instance (uses global default if None)
            **kwargs: Additional configuration options
        """
        super().__init__(image, memory_mib, cpus, runtime, **kwargs)

    async def run(self, code: str, timeout: Optional[int] = None) -> str:
        """
        Execute Python code in the secure container.

        Args:
            code: Python code to execute
            timeout: Execution timeout in seconds (not yet implemented)

        Returns:
            Execution stdout as a string. Use exec() directly if you need
            both stdout and stderr.

        Example:
            >>> async with CodeBox() as cb:
            ...     result = await cb.run("print('Hello, World!')")
            ...     print(result)
            Hello, World!

        Note:
            Uses python3 from the container images.
            For custom Python paths, use exec() directly:
                result = await cb.exec("/path/to/python", "-c", code)
        """
        # Execute Python code using python3 -c
        result = await self.exec("/usr/local/bin/python", "-c", code)
        return result.stdout

    async def run_script(self, script_path: str) -> str:
        """
        Execute a Python script file in the container.

        Args:
            script_path: Path to the Python script on the host

        Returns:
            Execution stdout as a string
        """
        with open(script_path, "r") as f:
            code = f.read()
        return await self.run(code)

    async def install_package(self, package: str) -> str:
        """
        Install a Python package in the container using pip.

        Args:
            package: Package name (e.g., 'requests', 'numpy==1.24.0')

        Returns:
            Installation output

        Example:
            >>> async with CodeBox() as cb:
            ...     await cb.install_package("requests")
            ...     result = await cb.run("import requests; print(requests.__version__)")
        """
        result = await self.exec("pip", "install", package)
        return result.stdout + result.stderr

    async def install_packages(self, *packages: str) -> str:
        """
        Install multiple Python packages.

        Args:
            *packages: Package names to install

        Returns:
            Installation output

        Example:
            >>> async with CodeBox() as cb:
            ...     await cb.install_packages("requests", "numpy", "pandas")
        """
        result = await self.exec("pip", "install", *packages)
        return result.stdout + result.stderr
