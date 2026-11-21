"""Snapshot file trees and publish validated tar contents into a new directory."""
from contextlib import suppress
from dataclasses import dataclass
import ctypes
import errno
import io
import os
from pathlib import Path, PurePosixPath
import secrets
import stat
import sys
import tarfile


MAX_UPLOAD_BYTES = 8 * 1024 * 1024


def _padded(size, alignment):
    return size + (-size % alignment)


def _tar_member(name, kind, size=0, linkname='', executable=False):
    member = tarfile.TarInfo(name)
    member.type = kind
    member.size = size
    member.linkname = linkname
    member.mode = 0o700 if kind == tarfile.DIRTYPE or executable else 0o600
    return member


def safe_name(name):
    if not isinstance(name, str) or not name or '\\' in name or any(ord(c) < 32 for c in name):
        raise ValueError('Invalid archive path')
    parts = name.split('/')
    if name.startswith('/') or '..' in parts:
        raise ValueError('Unsafe archive path')
    return str(PurePosixPath(name))


def open_node(name, parent=None, directory=False):
    flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK
    if directory:
        flags |= os.O_DIRECTORY
    return os.open(name, flags, dir_fd=parent)


@dataclass(frozen=True)
class SymbolicLink:
    target: str


class _DownloadTarInfo(tarfile.TarInfo):
    def _proc_member(self, archive):
        # Keep the on-wire end before tarfile substitutes a sparse logical size
        # or advances offset_data past an in-band GNU sparse map.
        stored_size = self.size
        member = super()._proc_member(archive)
        if member is self:
            self.stored_end = self.offset_data + stored_size
        return member


@dataclass
class _SparseFile:
    size: int
    extents: list[tuple[int, memoryview]]

    @classmethod
    def decode(cls, member, raw, next_header):
        pos = member.offset_data
        end = member.stored_end
        if not pos <= end <= len(raw) or _padded(end, tarfile.BLOCKSIZE) != next_header:
            raise ValueError('Truncated sparse archive member')
        extents = []
        previous_end = 0
        for offset, length in member.sparse:
            if offset < 0 or length < 0 or offset + length > member.size:
                raise ValueError('Invalid sparse extent')
            if not length:  # GNU headers may have unused (0, 0) slots.
                continue
            if offset < previous_end or pos + length > end:
                raise ValueError('Invalid sparse extent')
            extents.append((offset, raw[pos:pos + length]))
            previous_end = offset + length
            pos += length
        if pos != end:
            raise ValueError('Sparse extents do not match stored size')
        return cls(member.size, extents)

    def write(self, stream):
        for offset, chunk in self.extents:
            stream.seek(offset)
            stream.write(chunk)
        stream.truncate(self.size)


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
        self.parents = set()
        self.files = {}
        self.directories = set()
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
        parents = {str(parent) for parent in PurePosixPath(name).parents if str(parent) != '.'}
        if any(parent in self.files for parent in parents) or (data is not None and name in self.parents):
            raise ValueError('Archive file/directory conflict')
        self.parents.update(parents)
        if data is not None:
            self.files[name] = data
        else:
            self.directories.add(name)

    def tree(self):
        return self.directories | self.parents, self.files

    @classmethod
    def snapshot(cls, source):
        source = Path(source).absolute()
        result = cls()
        archive_size = 2 * tarfile.BLOCKSIZE  # End-of-archive marker.

        def reserve(member):
            nonlocal archive_size
            archive_size += len(member.tobuf(tarfile.PAX_FORMAT))
            archive_size += _padded(member.size, tarfile.BLOCKSIZE)
            if _padded(archive_size, tarfile.RECORDSIZE) > MAX_UPLOAD_BYTES:
                raise ValueError('Upload tar archive exceeds the 8 MiB limit')

        def visit_entry(parent, entry, name):
            if stat.S_ISLNK(os.stat(entry, dir_fd=parent, follow_symlinks=False).st_mode):
                target = os.readlink(entry, dir_fd=parent)
                reserve(_tar_member(name, tarfile.SYMTYPE, linkname=target))
                result.add(name, SymbolicLink(target))
                return
            fd = open_node(entry, parent)
            try:
                visit(fd, name)
            finally:
                os.close(fd)

        def visit(fd, name):
            before = os.fstat(fd)
            if stat.S_ISDIR(before.st_mode):
                reserve(_tar_member(name or '.', tarfile.DIRTYPE))
                if name:
                    result.add(name)
                with os.scandir(fd) as children:
                    for child in children:
                        relative = f'{name}/{child.name}' if name else child.name
                        visit_entry(fd, child.name, relative)
            elif stat.S_ISREG(before.st_mode):
                reserve(_tar_member(name, tarfile.REGTYPE, before.st_size))
                with os.fdopen(os.dup(fd), 'rb') as stream:
                    data = stream.read(before.st_size + 1)
                after = os.fstat(fd)
                if (before.st_size, before.st_mtime_ns, before.st_ctime_ns) != (
                        after.st_size, after.st_mtime_ns, after.st_ctime_ns) or len(data) != before.st_size:
                    raise ValueError('Source changed while being read')
                result.add(name, data)
                if before.st_mode & stat.S_IXUSR:
                    result.executables.add(name)
            else:
                raise ValueError('Only regular files, directories and symbolic links are supported')

        parent = os.open(source.parent, os.O_RDONLY | os.O_DIRECTORY)
        try:
            entry = source.name or '.'
            mode = os.stat(entry, dir_fd=parent, follow_symlinks=False).st_mode
            result.single_file = not stat.S_ISDIR(mode)
            visit_entry(parent, entry, entry if result.single_file else '')
        finally:
            os.close(parent)
        return result

    def encode(self):
        output = io.BytesIO()
        directories, files = self.tree()
        entries = [(d, None) for d in sorted(directories)] + sorted(files.items())
        if not self.single_file:
            entries.insert(0, ('.', None))
        with tarfile.open(fileobj=output, mode='w', format=tarfile.PAX_FORMAT) as archive:
            for name, data in entries:
                if data is None:
                    member = _tar_member(name, tarfile.DIRTYPE)
                elif isinstance(data, SymbolicLink):
                    member = _tar_member(name, tarfile.SYMTYPE, linkname=data.target)
                else:
                    member = _tar_member(name, tarfile.REGTYPE, len(data), executable=name in self.executables)
                archive.addfile(member, io.BytesIO(data) if isinstance(data, bytes) else None)
        return output.getvalue()

    @classmethod
    def decode(cls, raw):
        if len(raw) % 512:
            raise ValueError('Truncated archive')
        result = cls()
        with tarfile.open(fileobj=io.BytesIO(raw), mode='r:', tarinfo=_DownloadTarInfo) as archive:
            for member in archive:
                if member.size < 0:
                    raise ValueError('Negative archive member size')
                name = member.name
                if member.sparse is not None:
                    if not member.isfile():
                        raise ValueError('Invalid sparse archive member')
                    result.add(name, _SparseFile.decode(member, memoryview(raw), archive.offset))
                elif member.isfile():
                    if member.offset_data + member.size > len(raw):
                        raise ValueError('Truncated archive member')
                    data = archive.extractfile(member).read()
                    if len(data) != member.size:
                        raise ValueError('Truncated archive member')
                    result.add(name, data)
                elif member.isdir():
                    result.add(name)
                elif member.issym() and member.linkname:
                    result.add(name, SymbolicLink(member.linkname))
                else:
                    raise ValueError('Unsupported archive member')
            # tarfile can stop iteration without raising after a malformed member header.
            tail_size = len(raw) - archive.offset
            if tail_size < 1024 or raw.count(b'\0', archive.offset) != tail_size:
                raise ValueError('Missing or invalid tar end marker')
        return result

    def save(self, destination):
        directories, files = self.tree()
        destination = Path(destination).absolute()
        parent = os.open(destination.parent, os.O_RDONLY | os.O_DIRECTORY)
        stage_name = None
        stage = None
        root = None
        try:
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
                    if isinstance(data, SymbolicLink):
                        os.symlink(data.target, PurePosixPath(name).name, dir_fd=fd)
                        continue
                    file_fd = os.open(PurePosixPath(name).name,
                                      os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600, dir_fd=fd)
                    with os.fdopen(file_fd, 'w+b') as stream:
                        if isinstance(data, _SparseFile):
                            data.write(stream)
                        else:
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
