"""
Unit tests for boxlite error types (no VM required).

Tests the error hierarchy and exception behavior.
"""

import pytest
from boxlite.errors import (
    AlreadyExistsError,
    BoxliteError,
    ConfigError,
    DatabaseError,
    EngineError,
    ExecError,
    ExecutionError,
    ImageError,
    InternalError,
    InvalidArgumentError,
    InvalidStateError,
    NetworkError,
    NotFoundError,
    ParseError,
    PortalError,
    ResourceExhaustedError,
    RpcError,
    StoppedError,
    StorageError,
    TimeoutError,
)


class TestBoxliteError:
    """Test base BoxliteError exception."""

    def test_is_exception(self):
        """Test that BoxliteError is an Exception."""
        assert issubclass(BoxliteError, Exception)

    def test_can_raise(self):
        """Test that BoxliteError can be raised."""
        with pytest.raises(BoxliteError):
            raise BoxliteError("test error")

    def test_message(self):
        """Test that BoxliteError stores message."""
        err = BoxliteError("test message")
        assert str(err) == "test message"

    def test_empty_message(self):
        """Test BoxliteError with empty message."""
        err = BoxliteError()
        assert str(err) == ""


class TestExecError:
    """Test ExecError exception."""

    def test_inherits_boxlite_error(self):
        """Test that ExecError inherits from BoxliteError."""
        assert issubclass(ExecError, BoxliteError)

    def test_attributes(self):
        """Test that ExecError stores command, exit_code, and stderr."""
        err = ExecError(command="ls -la", exit_code=1, stderr="file not found")
        assert err.command == "ls -la"
        assert err.exit_code == 1
        assert err.stderr == "file not found"

    def test_message_format(self):
        """Test ExecError message format."""
        err = ExecError(command="cat /nonexistent", exit_code=2, stderr="No such file")
        assert "cat /nonexistent" in str(err)
        assert "2" in str(err)
        assert "No such file" in str(err)

    def test_can_catch_as_boxlite_error(self):
        """Test that ExecError can be caught as BoxliteError."""
        with pytest.raises(BoxliteError):
            raise ExecError("cmd", 1, "error")

    def test_negative_exit_code(self):
        """Test ExecError with negative exit code (signal termination)."""
        err = ExecError(command="sleep 100", exit_code=-9, stderr="killed")
        assert err.exit_code == -9

    def test_empty_stderr(self):
        """Test ExecError with empty stderr."""
        err = ExecError(command="false", exit_code=1, stderr="")
        assert err.stderr == ""


class TestTimeoutError:
    """Test TimeoutError exception."""

    def test_inherits_boxlite_error(self):
        """Test that TimeoutError inherits from BoxliteError."""
        assert issubclass(TimeoutError, BoxliteError)

    def test_can_raise(self):
        """Test that TimeoutError can be raised."""
        with pytest.raises(TimeoutError):
            raise TimeoutError("operation timed out")

    def test_can_catch_as_boxlite_error(self):
        """Test that TimeoutError can be caught as BoxliteError."""
        with pytest.raises(BoxliteError):
            raise TimeoutError("timeout")


class TestParseError:
    """Test ParseError exception."""

    def test_inherits_boxlite_error(self):
        """Test that ParseError inherits from BoxliteError."""
        assert issubclass(ParseError, BoxliteError)

    def test_can_raise(self):
        """Test that ParseError can be raised."""
        with pytest.raises(ParseError):
            raise ParseError("invalid JSON output")

    def test_can_catch_as_boxlite_error(self):
        """Test that ParseError can be caught as BoxliteError."""
        with pytest.raises(BoxliteError):
            raise ParseError("parse error")


class TestEngineError:
    """Test EngineError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(EngineError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(EngineError):
            raise EngineError("engine crashed")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise EngineError("engine error")

    def test_message(self):
        err = EngineError("unsupported engine: kvm")
        assert str(err) == "unsupported engine: kvm"


class TestConfigError:
    """Test ConfigError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(ConfigError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(ConfigError):
            raise ConfigError("invalid config")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise ConfigError("bad option")


class TestStorageError:
    """Test StorageError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(StorageError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(StorageError):
            raise StorageError("disk full")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise StorageError("I/O error")


class TestImageError:
    """Test ImageError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(ImageError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(ImageError):
            raise ImageError("image not found")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise ImageError("pull failed")


class TestPortalError:
    """Test PortalError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(PortalError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(PortalError):
            raise PortalError("portal connection lost")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise PortalError("gRPC portal error")


class TestNetworkError:
    """Test NetworkError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(NetworkError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(NetworkError):
            raise NetworkError("network unreachable")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise NetworkError("DNS resolution failed")


class TestRpcError:
    """Test RpcError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(RpcError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(RpcError):
            raise RpcError("gRPC status: UNAVAILABLE")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise RpcError("transport error")


class TestInternalError:
    """Test InternalError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(InternalError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(InternalError):
            raise InternalError("unexpected state")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise InternalError("internal error")


class TestExecutionError:
    """Test ExecutionError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(ExecutionError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(ExecutionError):
            raise ExecutionError("execution failed")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise ExecutionError("runtime exec error")


class TestNotFoundError:
    """Test NotFoundError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(NotFoundError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(NotFoundError):
            raise NotFoundError("box abc123 not found")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise NotFoundError("resource not found")


class TestAlreadyExistsError:
    """Test AlreadyExistsError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(AlreadyExistsError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(AlreadyExistsError):
            raise AlreadyExistsError("box already exists")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise AlreadyExistsError("duplicate")


class TestInvalidStateError:
    """Test InvalidStateError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(InvalidStateError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(InvalidStateError):
            raise InvalidStateError("box is stopped")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise InvalidStateError("wrong state")


class TestDatabaseError:
    """Test DatabaseError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(DatabaseError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(DatabaseError):
            raise DatabaseError("SQLite error: table not found")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise DatabaseError("db error")


class TestInvalidArgumentError:
    """Test InvalidArgumentError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(InvalidArgumentError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(InvalidArgumentError):
            raise InvalidArgumentError("invalid memory: -1")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise InvalidArgumentError("bad argument")


class TestStoppedError:
    """Test StoppedError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(StoppedError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(StoppedError):
            raise StoppedError("runtime is shut down")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise StoppedError("stopped")


class TestResourceExhaustedError:
    """Test ResourceExhaustedError exception."""

    def test_inherits_boxlite_error(self):
        assert issubclass(ResourceExhaustedError, BoxliteError)

    def test_can_raise(self):
        with pytest.raises(ResourceExhaustedError):
            raise ResourceExhaustedError("VM address spaces exhausted")

    def test_can_catch_as_boxlite_error(self):
        with pytest.raises(BoxliteError):
            raise ResourceExhaustedError("resource limit")


# ── All typed exceptions: parametrized tests ─────────────────────────────

# Complete list of the 16 Rust-mapped exception classes
RUST_MAPPED_EXCEPTIONS = [
    EngineError,
    ConfigError,
    StorageError,
    ImageError,
    PortalError,
    NetworkError,
    RpcError,
    InternalError,
    ExecutionError,
    NotFoundError,
    AlreadyExistsError,
    InvalidStateError,
    DatabaseError,
    InvalidArgumentError,
    StoppedError,
    ResourceExhaustedError,
]

# All 19 exception classes (Rust-mapped + Python convenience)
ALL_EXCEPTIONS = RUST_MAPPED_EXCEPTIONS + [ExecError, TimeoutError, ParseError]


class TestErrorHierarchy:
    """Test the complete error hierarchy."""

    @pytest.mark.parametrize(
        "exc_class",
        RUST_MAPPED_EXCEPTIONS,
        ids=lambda c: c.__name__,
    )
    def test_rust_mapped_errors_inherit_from_base(self, exc_class):
        """Every Rust-mapped exception inherits from BoxliteError."""
        assert issubclass(exc_class, BoxliteError)

    @pytest.mark.parametrize(
        "exc_class",
        ALL_EXCEPTIONS,
        ids=lambda c: c.__name__,
    )
    def test_all_errors_are_exceptions(self, exc_class):
        """Every exception type is a subclass of Exception."""
        assert issubclass(exc_class, Exception)

    @pytest.mark.parametrize(
        "exc_class",
        RUST_MAPPED_EXCEPTIONS,
        ids=lambda c: c.__name__,
    )
    def test_rust_mapped_errors_directly_inherit_base(self, exc_class):
        """Rust-mapped exceptions inherit directly from BoxliteError (flat hierarchy)."""
        assert BoxliteError in exc_class.__bases__

    def test_catch_all_with_base_class(self):
        """Test catching all boxlite errors with base class."""
        errors = [
            BoxliteError("base"),
            ExecError("cmd", 1, "err"),
            TimeoutError("timeout"),
            ParseError("parse"),
            EngineError("engine"),
            ConfigError("config"),
            StorageError("storage"),
            ImageError("image"),
            PortalError("portal"),
            NetworkError("network"),
            RpcError("rpc"),
            InternalError("internal"),
            ExecutionError("execution"),
            NotFoundError("not found"),
            AlreadyExistsError("exists"),
            InvalidStateError("state"),
            DatabaseError("db"),
            InvalidArgumentError("arg"),
            StoppedError("stopped"),
            ResourceExhaustedError("exhausted"),
        ]

        for error in errors:
            try:
                raise error
            except BoxliteError as e:
                assert e is error

    @pytest.mark.parametrize(
        "exc_class",
        RUST_MAPPED_EXCEPTIONS,
        ids=lambda c: c.__name__,
    )
    def test_specific_catch_does_not_catch_siblings(self, exc_class):
        """Catching one typed exception does not catch a different one."""
        # Pick a sibling that is different from exc_class
        sibling = next(e for e in RUST_MAPPED_EXCEPTIONS if e is not exc_class)
        with pytest.raises(sibling):
            # This should NOT be caught by exc_class
            try:
                raise sibling("test")
            except exc_class:
                pytest.fail(
                    f"Catching {exc_class.__name__} should not catch {sibling.__name__}"
                )


class TestErrorExports:
    """Test that errors are properly exported."""

    EXPECTED_EXPORTS = [
        "BoxliteError",
        # Rust-mapped
        "EngineError",
        "ConfigError",
        "StorageError",
        "ImageError",
        "PortalError",
        "NetworkError",
        "RpcError",
        "InternalError",
        "ExecutionError",
        "NotFoundError",
        "AlreadyExistsError",
        "InvalidStateError",
        "DatabaseError",
        "InvalidArgumentError",
        "StoppedError",
        "ResourceExhaustedError",
        # Python convenience
        "ExecError",
        "TimeoutError",
        "ParseError",
    ]

    @pytest.mark.parametrize("name", EXPECTED_EXPORTS)
    def test_errors_in_module(self, name):
        """Test that each error is exported from the boxlite module."""
        import boxlite

        assert hasattr(boxlite, name), f"boxlite.{name} should be exported"

    @pytest.mark.parametrize("name", EXPECTED_EXPORTS)
    def test_errors_from_errors_module(self, name):
        """Test that each error can be imported from boxlite.errors."""
        import boxlite.errors

        assert hasattr(boxlite.errors, name), f"boxlite.errors.{name} should exist"

    def test_errors_in_errors_module_all(self):
        """Test that all 19 exceptions are listed in errors.__all__."""
        from boxlite import errors

        for name in self.EXPECTED_EXPORTS:
            assert name in errors.__all__, f"{name} should be in errors.__all__"


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
