"""
SyncCodeBox - Synchronous wrapper for CodeBox.

Provides a synchronous API for Python code execution using greenlet fiber switching.
API mirrors async CodeBox exactly.
"""

from typing import TYPE_CHECKING, Optional

from ._simplebox import SyncSimpleBox

if TYPE_CHECKING:
    from ._boxlite import SyncBoxlite

__all__ = ["SyncCodeBox"]


class SyncCodeBox(SyncSimpleBox):
    """
    Synchronous wrapper for CodeBox.

    Provides synchronous methods for executing Python code in a secure container.
    Built on top of SyncSimpleBox with Python-specific convenience methods.
    API mirrors async CodeBox exactly.

    Usage (standalone - recommended):
        with SyncCodeBox() as box:
            result = box.run("print('Hello, World!')")
            print(result)  # Hello, World!

    Usage (with explicit runtime):
        with SyncBoxlite.default() as runtime:
            with SyncCodeBox(runtime=runtime) as box:
                result = box.run("print('Hello!')")
                print(result)
    """

    def __init__(
        self,
        image: str = "python:slim",
        memory_mib: Optional[int] = None,
        cpus: Optional[int] = None,
        runtime: Optional["SyncBoxlite"] = None,
        name: Optional[str] = None,
        auto_remove: bool = True,
        **kwargs,
    ):
        """
        Create a SyncCodeBox.

        Args:
            image: Python container image (default: "python:slim")
            memory_mib: Memory limit in MiB (default: system default)
            cpus: Number of CPU cores (default: system default)
            runtime: Optional SyncBoxlite runtime. If None, creates default runtime.
            name: Optional unique name for the box
            auto_remove: Remove box when stopped (default: True)
            **kwargs: Additional BoxOptions parameters
        """
        super().__init__(
            image=image,
            memory_mib=memory_mib,
            cpus=cpus,
            runtime=runtime,
            name=name,
            auto_remove=auto_remove,
            **kwargs,
        )

    def run(self, code: str, timeout: Optional[int] = None) -> str:
        """
        Execute Python code synchronously.

        Args:
            code: Python code to execute
            timeout: Execution timeout in seconds (not yet implemented)

        Returns:
            Execution stdout as a string. Use exec() directly if you need
            both stdout and stderr.

        Example:
            with SyncCodeBox() as box:
                result = box.run("print('Hello!')")
                print(result)  # Hello!

                # Multi-line code
                result = box.run('''
                import sys
                print(f"Python {sys.version}")
                ''')
        """
        result = self.exec("/usr/local/bin/python", "-c", code)
        return result.stdout

    def install_package(self, package: str) -> str:
        """
        Install a Python package using pip.

        Args:
            package: Package name (e.g., "requests", "numpy==1.24.0")

        Returns:
            Installation output

        Example:
            box.install_package("requests")
            result = box.run("import requests; print(requests.__version__)")
        """
        result = self.exec("pip", "install", package)
        return result.stdout + result.stderr

    def install_packages(self, *packages: str) -> str:
        """
        Install multiple Python packages.

        Args:
            *packages: Package names to install

        Returns:
            Installation output

        Example:
            box.install_packages("requests", "numpy", "pandas")
        """
        result = self.exec("pip", "install", *packages)
        return result.stdout + result.stderr

    def run_script(self, script_path: str) -> str:
        """
        Execute a Python script file.

        Reads the script from the host filesystem and executes it in the box.

        Args:
            script_path: Path to the Python script on the host

        Returns:
            Script stdout as a string

        Example:
            result = box.run_script("./my_script.py")
        """
        with open(script_path, "r") as f:
            code = f.read()
        return self.run(code)
