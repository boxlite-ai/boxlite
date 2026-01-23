"""
Unit tests for boxlite error types (no VM required).

Tests the error hierarchy and exception behavior.
"""

import pytest
from boxlite.errors import BoxliteError, ExecError, TimeoutError, ParseError


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


class TestErrorHierarchy:
    """Test the complete error hierarchy."""

    def test_all_errors_inherit_from_base(self):
        """Test that all error types inherit from BoxliteError."""
        assert issubclass(ExecError, BoxliteError)
        assert issubclass(TimeoutError, BoxliteError)
        assert issubclass(ParseError, BoxliteError)

    def test_all_errors_are_exceptions(self):
        """Test that all error types are Exceptions."""
        assert issubclass(BoxliteError, Exception)
        assert issubclass(ExecError, Exception)
        assert issubclass(TimeoutError, Exception)
        assert issubclass(ParseError, Exception)

    def test_catch_all_with_base_class(self):
        """Test catching all boxlite errors with base class."""
        errors = [
            BoxliteError("base"),
            ExecError("cmd", 1, "err"),
            TimeoutError("timeout"),
            ParseError("parse"),
        ]

        for error in errors:
            try:
                raise error
            except BoxliteError as e:
                assert e is error


class TestErrorExports:
    """Test that errors are properly exported."""

    def test_errors_in_module(self):
        """Test that errors are exported from boxlite module."""
        import boxlite

        assert hasattr(boxlite, "BoxliteError")
        assert hasattr(boxlite, "ExecError")
        assert hasattr(boxlite, "TimeoutError")
        assert hasattr(boxlite, "ParseError")

    def test_errors_from_errors_module(self):
        """Test that errors can be imported from errors module."""
        from boxlite.errors import BoxliteError, ExecError, TimeoutError, ParseError

        assert BoxliteError is not None
        assert ExecError is not None
        assert TimeoutError is not None
        assert ParseError is not None


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
