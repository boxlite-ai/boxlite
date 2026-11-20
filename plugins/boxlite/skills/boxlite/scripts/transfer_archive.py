"""Bounded regular-file archives; never extract untrusted tar metadata directly."""
from contextlib import suppress
import ctypes
import errno
import io
import os
from pathlib import Path, PurePosixPath
import secrets
import stat
import sys
import tarfile

MAX_BYTES = 8 * 1024 * 1024
MAX_ENTRIES = 1024
MAX_DEPTH = 32
PRIVATE = {'.git', '.ssh', '.aws', '.azure', '.config', '.cache', '.codex', '.claude',
           '.boxlite', '.bashrc', '.zshrc', '.netrc', '.npmrc', '.pypirc', 'id_rsa', 'id_ed25519', 'node_modules', '__pycache__', 'credentials.toml', 'credentials.json'}


def safe_name(name):
    if not isinstance(name, str) or not name or '\\' in name or any(ord(c) < 32 for c in name):
        raise ValueError('Invalid archive path')
    parts = name.split('/')
    if name.startswith('/') or '..' in parts or len(parts) > MAX_DEPTH:
        raise ValueError('Unsafe archive path or excessive depth')
    return str(PurePosixPath(name))


def public_name(name):
    name = safe_name(name)
    for part in PurePosixPath(name.casefold()).parts:
        if part in PRIVATE or part.startswith('.env') or part.endswith(('.pem', '.key')):
            raise ValueError('Sensitive or cache path refused; prepare a reviewed source directory')
    return name


def open_node(name, parent=None, directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        flags |= os.O_DIRECTORY
    return os.open(name, flags, dir_fd=parent)


def _publish_directory(source_parent, source, target_parent, target):
    libc = ctypes.CDLL(None, use_errno=True)
    if sys.platform == 'darwin':
        rename = getattr(libc, 'renameatx_np', None)
        flag = 0x4  # RENAME_EXCL
    else:
        rename = getattr(libc, 'renameat2', None)
        flag = 1  # RENAME_NOREPLACE
    if rename is None:
        raise ValueError('Atomic download placement is unavailable on this host')
    rename.argtypes = (ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint)
    rename.restype = ctypes.c_int
    if rename(source_parent, os.fsencode(source), target_parent, os.fsencode(target), flag):
        error = ctypes.get_errno()
        if error in (errno.ENOSYS, errno.ENOTSUP, errno.EINVAL):
            raise ValueError('Destination filesystem does not support atomic download placement')
        raise OSError(error, os.strerror(error), target)


def _clear_staging_directory(directory):
    for name in os.listdir(directory):
        if not stat.S_ISDIR(os.stat(name, dir_fd=directory, follow_symlinks=False).st_mode):
            os.unlink(name, dir_fd=directory)
            continue
        child = open_node(name, directory, directory=True)
        try:
            _clear_staging_directory(child)
        finally:
            os.close(child)
        os.rmdir(name, dir_fd=directory)


class Archive:
    """Own a validated in-memory tree and expose snapshot, encode and save operations."""
    def __init__(self):
        self.files = {}
        self.directories = set()
        self.size = 0
        self.single_file = False
        self.executables = set()

    def add(self, name, data=None):
        name = safe_name(name)
        if name == '.':
            if data is not None:
                raise ValueError('Archive root must be a directory')
            return
        if name in self.files or name in self.directories:
            raise ValueError('Duplicate archive path')
        for parent in PurePosixPath(name).parents:
            if str(parent) in self.files:
                raise ValueError('Archive file/directory conflict')
        if data is not None:
            if any(p.startswith(name + '/') for p in (*self.files, *self.directories)):
                raise ValueError('Archive file/directory conflict')
            self.size += len(data)
            if self.size > MAX_BYTES:
                raise ValueError('Transfer exceeds 8 MiB')
            self.files[name] = data
        else:
            self.directories.add(name)
        if len(self.files) + len(self.directories) > MAX_ENTRIES:
            raise ValueError('Too many archive entries')

    def tree(self):
        dirs = set(self.directories)
        for name in (*self.files, *dirs):
            dirs.update(str(p) for p in PurePosixPath(name).parents if str(p) != '.')
        if len(dirs) + len(self.files) > MAX_ENTRIES:
            raise ValueError('Too many implicit archive directories')
        return dirs, self.files

    @classmethod
    def snapshot(cls, source):
        source = Path(source).absolute()
        public_name(source.as_posix().lstrip('/'))
        result = cls()

        def visit(fd, name):
            before = os.fstat(fd)
            if stat.S_ISDIR(before.st_mode):
                if name:
                    result.add(name)
                remaining = MAX_ENTRIES - len(result.files) - len(result.directories)
                children = []
                with os.scandir(fd) as entries:
                    for entry in entries:
                        if len(children) == remaining:
                            raise ValueError('Too many archive entries')
                        children.append(entry.name)
                for child in sorted(children):
                    relative = public_name(f'{name}/{child}' if name else child)
                    child_fd = open_node(child, fd)
                    try:
                        visit(child_fd, relative)
                    finally:
                        os.close(child_fd)
            elif stat.S_ISREG(before.st_mode):
                if before.st_nlink != 1 or before.st_size > MAX_BYTES - result.size:
                    raise ValueError('Hardlinked or oversized source refused')
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    data = stream.read(MAX_BYTES - result.size + 1)
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                        after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != before.st_size:
                    raise ValueError('Source changed while being read')
                result.add(name, data)
                if before.st_mode & stat.S_IXUSR:
                    result.executables.add(name)
            else:
                raise ValueError('Only regular files and directories are supported')

        # Anchor every component, including ancestors, rather than checking then reopening paths.
        fd = open_node(source.anchor, directory=True)
        try:
            for component in source.parts[1:]:
                next_fd = open_node(component, fd)
                os.close(fd)
                fd = next_fd
            result.single_file = stat.S_ISREG(os.fstat(fd).st_mode)
            visit(fd, source.name if result.single_file else '')
        finally:
            os.close(fd)
        return result

    def encode(self):
        output = io.BytesIO()
        directories, files = self.tree()
        entries = [(d, None) for d in sorted(directories)] + sorted(files.items())
        if not self.single_file:
            entries.insert(0, ('.', None))
        with tarfile.open(fileobj=output, mode='w', format=tarfile.USTAR_FORMAT) as archive:
            for name, data in entries:
                member = tarfile.TarInfo(name)
                member.mode = 0o700 if data is None or name in self.executables else 0o600
                if data is None:
                    member.type = tarfile.DIRTYPE
                else:
                    member.size = len(data)
                try:
                    archive.addfile(member, None if data is None else io.BytesIO(data))
                except ValueError:
                    raise ValueError('Source path cannot be represented in USTAR; use a shorter path') from None
                if output.tell() > MAX_BYTES:
                    raise ValueError('Tar archive exceeds 8 MiB including headers')
        if output.tell() > MAX_BYTES:
            raise ValueError('Tar archive exceeds 8 MiB including padding')
        return output.getvalue()

    @classmethod
    def decode(cls, raw):
        if len(raw) > MAX_BYTES or len(raw) % 512:
            raise ValueError('Oversized or truncated archive')
        result = cls()
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:') as archive:
            count = 0
            for member in archive:
                count += 1
                if count > MAX_ENTRIES + 1 or member.sparse is not None or not (member.isfile() or member.isdir()):
                    raise ValueError('Unsupported archive member')
                if member.size < 0 or member.size > MAX_BYTES - result.size:
                    raise ValueError('Oversized archive member')
                name = safe_name(member.name)
                if member.isfile():
                    if member.offset_data + member.size > len(raw):
                        raise ValueError('Truncated archive member')
                    data = archive.extractfile(member).read()
                    if len(data) != member.size:
                        raise ValueError('Truncated archive member')
                    result.add(name, data)
                else:
                    result.add(name)
            # tarfile can stop iteration without raising after a malformed member header.
            tail_size = len(raw) - archive.offset
            if tail_size < 1024 or raw.count(b'\0', archive.offset) != tail_size:
                raise ValueError('Missing or invalid tar end marker')
        result.tree()
        return result

    def save(self, destination):
        directories, files = self.tree()
        destination = Path(destination).absolute()
        parent = open_node(destination.anchor, directory=True)
        stage_name = None
        stage = None
        root = None
        try:
            for component in destination.parts[1:-1]:
                next_fd = open_node(component, parent, directory=True)
                os.close(parent)
                parent = next_fd
            candidate = '.boxlite-download-' + secrets.token_hex(16)
            os.mkdir(candidate, 0o700, dir_fd=parent)
            stage_name = candidate
            stage = open_node(stage_name, parent, directory=True)
            os.mkdir('files', 0o700, dir_fd=stage)
            root = open_node('files', stage, directory=True)
            for name in sorted(directories, key=lambda p: (p.count('/'), p)):
                fd = self._parent(root, name)
                try:
                    os.mkdir(PurePosixPath(name).name, 0o700, dir_fd=fd)
                finally:
                    os.close(fd)
            for name, data in files.items():
                fd = self._parent(root, name)
                try:
                    file_fd = os.open(PurePosixPath(name).name,
                                      os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                    with os.fdopen(file_fd, 'w+b') as stream:
                        stream.write(data)
                finally:
                    os.close(fd)
            _publish_directory(stage, 'files', parent, destination.name)
            try:
                reported = os.stat(destination, follow_symlinks=False)
            except OSError:
                raise ValueError('Download was written but the requested path no longer identifies it') from None
            if not os.path.samestat(os.fstat(root), reported):
                raise ValueError('Download was written but the requested path no longer identifies it')
        finally:
            if root is not None:
                os.close(root)
            if stage is not None:
                with suppress(OSError):
                    _clear_staging_directory(stage)
                os.close(stage)
            if stage_name is not None:
                with suppress(OSError):
                    os.rmdir(stage_name, dir_fd=parent)
            os.close(parent)

    @staticmethod
    def _parent(root, name):
        fd = os.dup(root)
        try:
            for component in PurePosixPath(name).parts[:-1]:
                next_fd = open_node(component, fd, directory=True)
                os.close(fd)
                fd = next_fd
            return fd
        except BaseException:
            os.close(fd)
            raise
