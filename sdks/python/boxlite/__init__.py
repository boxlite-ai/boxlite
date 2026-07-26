"""
BoxLite - Lightweight, secure containerization for any environment.

Following SQLite philosophy: "BoxLite" for branding, "boxlite" for code APIs.
"""

import warnings

# Import core Rust API
try:
    from .boxlite import (
        AccessToken,
        ApiKeyCredential,
        AdvancedBoxOptions,
        Box,
        BoxInfo,
        Boxlite,
        BoxliteRestOptions,
        BoxMetrics,
        BoxOptions,
        BoxStateInfo,
        CloneOptions,
        CopyOptions,
        ExecStderr,
        ExecStdout,
        Execution,
        ExportOptions,
        HealthCheckOptions,
        HealthState,
        HealthStatus,
        ImageHandle,
        ImageInfo,
        ImagePullResult,
        ImageRegistry,
        NetworkHandle,
        NetworkSpec,
        Options,
        RestartPolicy,
        RuntimeMetrics,
        Secret,
        SecurityOptions,
        SnapshotHandle,
        SnapshotInfo,
        SnapshotOptions,
        VolumeHandle,
        VolumeInfo,
    )

    __all__ = [  # noqa: RUF022 - grouped by API area, not alphabetical
        # Core Rust API
        "Options",
        "ImageRegistry",
        "BoxOptions",
        "AdvancedBoxOptions",
        "BoxliteRestOptions",
        "ApiKeyCredential",
        "AccessToken",
        "Boxlite",
        "NetworkSpec",
        "NetworkHandle",
        "Box",
        "Execution",
        "ExecStdout",
        "ExecStderr",
        "ImageHandle",
        "ImageInfo",
        "ImagePullResult",
        "BoxInfo",
        "BoxStateInfo",
        "HealthState",
        "HealthStatus",
        "RuntimeMetrics",
        "BoxMetrics",
        "CopyOptions",
        "HealthCheckOptions",
        "RestartPolicy",
        "SecurityOptions",
        "Secret",
        "SnapshotHandle",
        "SnapshotInfo",
        "SnapshotOptions",
        "CloneOptions",
        "ExportOptions",
        "VolumeHandle",
        "VolumeInfo",
    ]
    # Credential abstraction (ABC + virtual-registered native classes)
    from .credential import Credential  # noqa: F401

    __all__.append("Credential")
except ImportError as e:
    warnings.warn(f"BoxLite native extension not available: {e}", ImportWarning)
    __all__ = []

# Import Python convenience wrappers (re-exported via __all__)
try:
    from .codebox import CodeBox  # noqa: F401
    from .errors import BoxliteError, ExecError, ParseError, TimeoutError  # noqa: F401
    from .exec import ExecResult  # noqa: F401
    from .simplebox import SimpleBox  # noqa: F401

    __all__.extend(
        [  # noqa: RUF022 - grouped by API area, not alphabetical
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
    from .orchestration import BoxGroup, BoxRuntime, ManagedBox  # noqa: F401

    __all__.extend(["BoxGroup", "BoxRuntime", "ManagedBox"])
except ImportError:
    pass

# Sync API (greenlet-based synchronous wrappers, re-exported via __all__)
# Requires greenlet: pip install boxlite[sync]
try:
    from .sync_api import (  # noqa: F401
        SyncBox,
        SyncBoxlite,
        SyncCodeBox,
        SyncExecStderr,
        SyncExecStdout,
        SyncExecution,
        SyncImageHandle,
        SyncNetworkHandle,
        SyncSimpleBox,
        SyncSkillBox,
    )

    __all__.extend(
        [
            "SyncBox",
            "SyncBoxlite",
            "SyncCodeBox",
            "SyncExecStderr",
            "SyncExecStdout",
            "SyncExecution",
            "SyncImageHandle",
            "SyncNetworkHandle",
            "SyncSimpleBox",
            "SyncSkillBox",
        ]
    )
except ImportError:
    # greenlet not installed - sync API not available
    pass

# Get version from package metadata
try:
    from importlib.metadata import PackageNotFoundError, version

    __version__ = version("boxlite")
except PackageNotFoundError:
    # Package not installed (e.g., development mode)
    __version__ = "0.0.0+dev"
