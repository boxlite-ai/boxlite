#!/usr/bin/env python3
"""Minimal FUSE filesystem: serves one read-only virtual file /hello.txt."""

import os
import sys
import stat
import errno

from fuse import FUSE, FuseOSError, Operations


class HelloFS(Operations):
    DATA = b"Hello from FUSE inside BoxLite!\n"

    def getattr(self, path, fh=None):
        if path == "/":
            return {"st_mode": stat.S_IFDIR | 0o755, "st_nlink": 2}
        if path == "/hello.txt":
            return {"st_mode": stat.S_IFREG | 0o444, "st_size": len(self.DATA)}
        raise FuseOSError(errno.ENOENT)

    def readdir(self, path, fh):
        return [".", "..", "hello.txt"]

    def read(self, path, size, offset, fh):
        return self.DATA[offset:offset + size]


if __name__ == "__main__":
    mountpoint = sys.argv[1] if len(sys.argv) > 1 else "/mnt/hello"
    os.makedirs(mountpoint, exist_ok=True)
    print(f"Mounting HelloFS at {mountpoint}", flush=True)
    FUSE(HelloFS(), mountpoint, foreground=True, nothreads=True)
