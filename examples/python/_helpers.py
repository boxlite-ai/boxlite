"""Shared utilities for BoxLite Python examples."""

import logging
import sys


def setup_logging(level: int = logging.ERROR) -> None:
    """Configure stdout logging for examples.

    Args:
        level: Logging level (default: ERROR to suppress noisy runtime logs).
    """
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(levelname)s] %(message)s",
        handlers=[logging.StreamHandler(sys.stdout)],
    )
