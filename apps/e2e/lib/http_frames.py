"""Framing for the known Content-Length guest fixture (not a general HTTP parser)."""

MAX_RESPONSE_BYTES = 8 * 1024 * 1024


def response_size(data: bytes) -> int | None:
    boundary = data.find(b"\r\n\r\n")
    if boundary < 0:
        if len(data) > 64 * 1024:
            raise AssertionError("guest HTTP headers exceeded 64 KiB")
        return None
    lines = data[:boundary].split(b"\r\n")
    assert lines[0].startswith((b"HTTP/1.0 200 ", b"HTTP/1.1 200 ")), "guest HTTP status was not 200"
    lengths = [line.split(b":", 1)[1].strip() for line in lines[1:]
               if line.lower().startswith(b"content-length:")]
    assert len(lengths) == 1 and lengths[0].isdigit(), "guest response needs one Content-Length"
    total = boundary + 4 + int(lengths[0])
    assert total <= MAX_RESPONSE_BYTES, "guest response exceeded 8 MiB"
    return total


class UnexpectedTunnelEOF(RuntimeError):
    """Only the known TLS shutdown failure, after a complete guest response."""


class HalfCloseResponseLost(AssertionError):
    """A prepared, working tunnel lost the response after shutdown_write."""
