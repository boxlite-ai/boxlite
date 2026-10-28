"""Guest-only probe: bound DNS as well as sockets, report completion explicitly."""
import errno
import json
import multiprocessing
import socket
import ssl
import sys
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *_args, **_kwargs):
        return None


def request(url, output):
    try:
        # Measure this destination. Following a redirect would probe a second,
        # potentially unlisted host and mislabel an allowed IP as blocked.
        opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())
        with opener.open(url, timeout=5) as response:
            response.read(1)
        output.send({"reachable": True})
    except urllib.error.HTTPError:
        output.send({"reachable": True})  # The peer returned an HTTP response.
    except (urllib.error.URLError, OSError) as error:
        cause = getattr(error, "reason", error)
        # The allowlist closes rejected TLS flows after reading their SNI.
        # Certificate/handshake errors remain failures; an orderly/abrupt EOF
        # is transport refusal, checked against an unrestricted control.
        refused = isinstance(cause, (ConnectionError, TimeoutError, socket.gaierror,
                                     ssl.SSLZeroReturnError, ssl.SSLEOFError)) or getattr(cause, "errno", None) in (
            errno.ECONNREFUSED, errno.ECONNRESET, errno.ENETUNREACH,
            errno.EHOSTUNREACH, errno.ETIMEDOUT,
        )
        if refused:
            output.send({"reachable": False})
        else:
            output.send({"error_type": type(cause).__name__, "error_reason": getattr(cause, "reason", None)})
    finally:
        output.close()


context = multiprocessing.get_context("fork")  # The probe executes in a Linux guest.
receive, send = context.Pipe(duplex=False)
worker = context.Process(target=request, args=(sys.argv[1], send))
worker.start()
send.close()
try:
    # Socket timeouts do not bound libc DNS when runtime-disabled suspends the NIC.
    if receive.poll(8):
        record = receive.recv()  # Unexpected child exit/empty pipe is a probe failure.
    else:
        record = {"reachable": False}
finally:
    if worker.is_alive():
        worker.terminate()
    worker.join(timeout=2)
    if worker.is_alive():
        worker.kill()
        worker.join()
    receive.close()
print(json.dumps({"probe": "boxlite-egress-v1", **record}), flush=True)
sys.exit(1 if "error_type" in record else 0)
