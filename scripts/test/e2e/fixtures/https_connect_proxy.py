#!/usr/bin/env python3

import os
import socket
import ssl
import sys
import threading


def copy_stdin(conn: ssl.SSLSocket) -> None:
    try:
        while data := os.read(sys.stdin.fileno(), 64 * 1024):
            conn.sendall(data)
    finally:
        try:
            conn.shutdown(socket.SHUT_WR)
        except OSError:
            pass


def main() -> None:
    if len(sys.argv) != 5:
        raise SystemExit(
            f"usage: {sys.argv[0]} PROXY_HOST PROXY_PORT TARGET_HOST TARGET_PORT"
        )

    proxy_host, proxy_port, target_host, target_port = sys.argv[1:]
    raw = socket.create_connection((proxy_host, int(proxy_port)), timeout=15)
    conn = ssl.create_default_context().wrap_socket(raw, server_hostname=proxy_host)
    authority = f"{target_host}:{target_port}"
    conn.sendall(
        f"CONNECT {authority} HTTP/1.1\r\n"
        f"Host: {authority}\r\n"
        "Proxy-Connection: Keep-Alive\r\n\r\n".encode()
    )

    response = bytearray()
    while b"\r\n\r\n" not in response:
        chunk = conn.recv(4096)
        if not chunk:
            raise SystemExit("proxy closed during CONNECT handshake")
        response.extend(chunk)
        if len(response) > 64 * 1024:
            raise SystemExit("proxy returned oversized CONNECT response")

    headers, buffered = response.split(b"\r\n\r\n", 1)
    status = headers.split(b"\r\n", 1)[0]
    if b" 200 " not in status:
        raise SystemExit(f"CONNECT rejected: {status.decode(errors='replace')}")
    if buffered:
        os.write(sys.stdout.fileno(), buffered)

    threading.Thread(target=copy_stdin, args=(conn,), daemon=True).start()
    while data := conn.recv(64 * 1024):
        os.write(sys.stdout.fileno(), data)


if __name__ == "__main__":
    main()
