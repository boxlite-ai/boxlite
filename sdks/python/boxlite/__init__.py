"""
BoxLite - Lightweight, secure containerization for any environment.

Following SQLite philosophy: "BoxLite" for branding, "boxlite" for code APIs.
"""

import warnings

# Import core Rust API
try:
    from .boxlite import (
        Options,
        BoxOptions,
        BoxliteRestOptions,
        Boxlite,
        Box,
        Execution,
        ExecStdout,
        ExecStderr,
        BoxInfo,
        BoxStateInfo,
        RuntimeMetrics,
        BoxMetrics,
        CopyOptions,
        RootfsSpec,
        SecurityOptions,
    )

    __all__ = [
        # Core Rust API
        "Options",
        "BoxOptions",
        "BoxliteRestOptions",
        "Boxlite",
        "Box",
        "Execution",
        "ExecStdout",
        "ExecStderr",
        "BoxInfo",
        "BoxStateInfo",
        "RuntimeMetrics",
        "BoxMetrics",
        "CopyOptions",
        "RootfsSpec",
        "SecurityOptions",
    ]
except ImportError as e:
    warnings.warn(f"BoxLite native extension not available: {e}", ImportWarning)
    __all__ = []

# Import Python convenience wrappers (re-exported via __all__)
try:
    from .simplebox import SimpleBox  # noqa: F401
    from .exec import ExecResult  # noqa: F401
    from .codebox import CodeBox  # noqa: F401
    from .errors import BoxliteError, ExecError, TimeoutError, ParseError  # noqa: F401

    __all__.extend(
        [
            # Python convenience wrappers
            "SimpleBox",
            "CodeBox",
            "ExecResult",
            # Error types
            "BoxliteError",
            "ExecError",
            "TimeoutError",
            "ParseError",
        ]
    )
except ImportError:
    pass

# Specialized containers (re-exported via __all__)
try:
    from .browserbox import BrowserBox, BrowserBoxOptions  # noqa: F401

    __all__.extend(["BrowserBox", "BrowserBoxOptions"])
except ImportError:
    pass

try:
    from .computerbox import ComputerBox  # noqa: F401

    __all__.extend(["ComputerBox"])
except ImportError:
    pass

try:
    from .interactivebox import InteractiveBox  # noqa: F401

    __all__.extend(["InteractiveBox"])
except ImportError:
    pass

try:
    from .skillbox import SkillBox  # noqa: F401

    __all__.extend(["SkillBox"])
except ImportError:
    pass

# Multi-box orchestration (guest-initiated messaging)
try:
    from .orchestration import BoxRuntime, ManagedBox, BoxGroup  # noqa: F401

    __all__.extend(["BoxRuntime", "ManagedBox", "BoxGroup"])
except ImportError:
    pass

# Sync API (greenlet-based synchronous wrappers, re-exported via __all__)
# Requires greenlet: pip install boxlite[sync]
try:
    from .sync_api import (  # noqa: F401
        SyncBoxlite,
        SyncBox,
        SyncExecution,
        SyncExecStdout,
        SyncExecStderr,
        SyncSimpleBox,
        SyncCodeBox,
        SyncSkillBox,
    )

    __all__.extend(
        [
            "SyncBoxlite",
            "SyncBox",
            "SyncExecution",
            "SyncExecStdout",
            "SyncExecStderr",
            "SyncSimpleBox",
            "SyncCodeBox",
            "SyncSkillBox",
        ]
    )
except ImportError:
    # greenlet not installed - sync API not available
    pass

# Get version from package metadata
try:
    from importlib.metadata import version, PackageNotFoundError

    __version__ = version("boxlite")
except PackageNotFoundError:
    # Package not installed (e.g., development mode)
    __version__ = "0.0.0+dev"
