"""Single import site for the BoxLite SDK symbols.

The SDK resolves under two layouts depending on how it was installed:
  - `boxlite`           (installed wheel — symbols re-exported at top level)
  - `boxlite.boxlite`   (editable/source checkout — symbols on the inner module)

`import_sdk()` papers over that one fallback in ONE place so call sites just do
`Boxlite, BoxOptions = import_sdk()`. It is intentionally LAZY (a function, not
a module-level import): the orchestrator package must import without the SDK
present so `doctor.check_sdk` can report a missing SDK as a failed check rather
than crash the whole package on import. It raises `ImportError` when neither
layout resolves — which is exactly what `check_sdk` catches.
"""

from __future__ import annotations


def import_sdk():
    """Return `(Boxlite, BoxOptions)` from whichever SDK layout is installed.

    Raises `ImportError` if the BoxLite SDK is not importable at all.
    """
    try:
        from boxlite import Boxlite, BoxOptions
    except ImportError:
        from boxlite.boxlite import Boxlite, BoxOptions  # type: ignore
    return Boxlite, BoxOptions
