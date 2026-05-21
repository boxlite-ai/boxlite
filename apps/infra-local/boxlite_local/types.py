"""Shared data structures for the orchestrator. Pure data, no I/O."""

from __future__ import annotations

from dataclasses import dataclass, field
from enum import Enum
from typing import Callable, Optional, TYPE_CHECKING

if TYPE_CHECKING:
    from .config import InfraConfig


class Severity(str, Enum):
    OK = "ok"
    FAIL = "fail"
    WARN = "warn"  # reserved for future use


@dataclass
class HealthCheck:
    """Box health probe. One of `exec`, `tcp_port`, `http_url` should be set."""
    exec: Optional[list[str] | Callable[["InfraConfig"], list[str]]] = None
    tcp_port: Optional[int] = None
    http_url: Optional[str] = None
    interval_s: float = 2.0
    timeout_s: float = 5.0
    retries: int = 30
    start_period_s: float = 0.0


@dataclass
class ServiceSpec:
    """Declarative definition of one BoxLite-backed service."""
    name: str
    image: str
    cpus: int = 1
    memory_mib: int = 256
    ports: list[tuple[int, int]] = field(default_factory=list)
    env: Callable[["InfraConfig"], dict[str, str]] = field(default=lambda cfg: {})
    volumes: Callable[["InfraConfig"], list[tuple[str, str]]] = field(default=lambda cfg: [])
    cmd: Optional[list[str] | Callable[["InfraConfig"], list[str]]] = None
    entrypoint: Optional[list[str]] = None   # overrides image entrypoint (e.g. ["sh"]); None keeps image default
    working_dir: Optional[str] = None
    depends_on: list[str] = field(default_factory=list)
    healthcheck: Optional[HealthCheck] = None
    one_shot: bool = False
    auto_remove: bool = False


@dataclass
class DoctorCheck:
    """One outcome of a doctor preflight probe."""
    name: str
    severity: Severity
    msg: str
    hint: Optional[str] = None


@dataclass
class DoctorReport:
    checks: list[DoctorCheck]

    def any_fail(self) -> bool:
        return any(c.severity == Severity.FAIL for c in self.checks)


class DoctorError(Exception):
    """Raised when doctor(strict=True) sees any FAIL-severity check."""

    def __init__(self, report: DoctorReport):
        self.report = report
        msg = "; ".join(c.msg for c in report.checks if c.severity == Severity.FAIL)
        super().__init__(f"doctor failed: {msg}")
