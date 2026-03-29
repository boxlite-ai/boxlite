#!/usr/bin/env python3
"""
Simple HTTPS echo server for testing secret substitution.

Starts a local HTTPS server that prints all incoming request headers.
Use this to verify that the MITM proxy substitutes the placeholder
with the real secret value.

Usage:
    # Terminal 1: start this server
    python examples/python/04_interactive/test_secret_server.py

    # Terminal 2: run the interactive shell (with secrets pointing to this server)
    python examples/python/04_interactive/run_interactive_shell.py

    # Inside the shell:
    wget -qO- --header="Authorization: Bearer $BOXLITE_SECRET_OPENAI" https://10.0.2.2:8443/test
"""

import http.server
import json
import ssl
import tempfile
import os
from datetime import datetime, timedelta, timezone

# Generate a self-signed cert for the test server
def generate_self_signed_cert():
    """Generate a self-signed cert + key using the cryptography library, or fall back to openssl CLI."""
    cert_file = tempfile.NamedTemporaryFile(suffix=".pem", delete=False)
    key_file = tempfile.NamedTemporaryFile(suffix=".pem", delete=False)

    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import ec
        import ipaddress

        key = ec.generate_private_key(ec.SECP256R1())
        subject = issuer = x509.Name([
            x509.NameAttribute(NameOID.COMMON_NAME, "test-secret-server"),
        ])
        cert = (
            x509.CertificateBuilder()
            .subject_name(subject)
            .issuer_name(issuer)
            .public_key(key.public_key())
            .serial_number(x509.random_serial_number())
            .not_valid_before(datetime.now(timezone.utc))
            .not_valid_after(datetime.now(timezone.utc) + timedelta(hours=1))
            .add_extension(
                x509.SubjectAlternativeName([
                    x509.DNSName("localhost"),
                    x509.DNSName("secret-test.boxlite"),
                    x509.IPAddress(ipaddress.IPv4Address("127.0.0.1")),
                    x509.IPAddress(ipaddress.IPv4Address("192.168.127.1")),
                ]),
                critical=False,
            )
            .sign(key, hashes.SHA256())
        )

        cert_file.write(cert.public_bytes(serialization.Encoding.PEM))
        key_file.write(key.private_bytes(
            serialization.Encoding.PEM,
            serialization.PrivateFormat.TraditionalOpenSSL,
            serialization.NoEncryption(),
        ))
    except ImportError:
        # Fall back to openssl CLI
        import subprocess
        cert_file.close()
        key_file.close()
        subprocess.run([
            "openssl", "req", "-x509", "-newkey", "ec",
            "-pkeyopt", "ec_paramgen_curve:prime256v1",
            "-keyout", key_file.name,
            "-out", cert_file.name,
            "-days", "1", "-nodes",
            "-subj", "/CN=test-secret-server",
            "-addext", "subjectAltName=DNS:localhost,DNS:secret-test.boxlite,IP:127.0.0.1,IP:192.168.127.1",
        ], check=True, capture_output=True)
        return cert_file.name, key_file.name

    cert_file.close()
    key_file.close()
    return cert_file.name, key_file.name


class SecretEchoHandler(http.server.BaseHTTPRequestHandler):
    """Echoes all request headers as JSON, highlighting secret-related ones."""

    def do_GET(self):
        self._handle()

    def do_POST(self):
        self._handle()

    def _handle(self):
        # Read body if present
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length).decode("utf-8", errors="replace") if content_length > 0 else ""

        # Collect all headers
        headers = {k: v for k, v in self.headers.items()}

        # Build response
        response = {
            "path": self.path,
            "method": self.command,
            "headers": headers,
            "body": body if body else None,
        }

        # Print to server console with highlighting
        print(f"\n{'='*60}")
        print(f"  {self.command} {self.path}")
        print(f"  Time: {datetime.now().strftime('%H:%M:%S')}")
        print(f"{'='*60}")

        for k, v in headers.items():
            # Highlight Authorization and secret-related headers
            if "secret" in k.lower() or "authorization" in k.lower() or "api-key" in k.lower():
                print(f"  \033[1;32m{k}: {v}\033[0m  <-- SECRET HEADER")
            else:
                print(f"  {k}: {v}")

        if body:
            print(f"\n  Body: {body[:500]}")
            if "BOXLITE_SECRET" in body:
                print(f"  \033[1;31m  ^^^ PLACEHOLDER NOT SUBSTITUTED!\033[0m")
            elif any(word in body for word in ["sk-", "key-", "token-"]):
                print(f"  \033[1;32m  ^^^ Real secret value received!\033[0m")

        # Check if Authorization has real value or placeholder
        auth = headers.get("Authorization", "")
        if "BOXLITE_SECRET" in auth:
            print(f"\n  \033[1;31m  FAIL: Placeholder was NOT substituted!\033[0m")
        elif auth and "Bearer" in auth:
            print(f"\n  \033[1;32m  OK: Authorization header has substituted value\033[0m")

        print(f"{'='*60}\n")

        # Send JSON response
        resp_body = json.dumps(response, indent=2).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(resp_body)))
        self.end_headers()
        self.wfile.write(resp_body)

    def log_message(self, format, *args):
        # Suppress default access log (we print our own)
        pass


def main():
    # Must be port 443 — gvproxy MITM only intercepts port 443 (standard HTTPS)
    port = int(os.environ.get("PORT", "443"))
    cert_file, key_file = generate_self_signed_cert()

    try:
        context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        context.load_cert_chain(cert_file, key_file)

        server = http.server.HTTPServer(("0.0.0.0", port), SecretEchoHandler)
        server.socket = context.wrap_socket(server.socket, server_side=True)

        print(f"\n{'='*60}")
        print(f"  Secret Echo Server (HTTPS)")
        print(f"  Listening on: https://0.0.0.0:{port}")
        print(f"{'='*60}")
        print(f"\n  IMPORTANT: Must run on port 443 for MITM to intercept!")
        print(f"    sudo python examples/python/04_interactive/test_secret_server.py")
        print(f"\n  From inside the guest VM, first add DNS:")
        print(f"    echo '192.168.127.1 secret-test.boxlite' >> /etc/hosts")
        print(f"\n  Then test:")
        print(f"    wget -qO- --no-check-certificate \\")
        print(f"      --header='Authorization: Bearer <BOXLITE_SECRET:openai>' \\")
        print(f"      https://secret-test.boxlite/test")
        print(f"\n  If MITM works: Authorization header shows real key")
        print(f"  If MITM fails: Authorization header shows placeholder")
        print(f"\n  Press Ctrl+C to stop\n")

        server.serve_forever()
    except KeyboardInterrupt:
        print("\nServer stopped.")
    finally:
        os.unlink(cert_file)
        os.unlink(key_file)


if __name__ == "__main__":
    main()
