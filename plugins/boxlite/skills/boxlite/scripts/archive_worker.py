"""Archive I/O for an authorized Claude transfer. File bytes use standard streams."""
import json
import os
from pathlib import Path
import re
import stat
import sys

from transfer_archive import open_node
from transfer import TransferError, pack_source, save_archive


def saved_archive(receipt):
    # The server can return text resembling a Claude persistence notice. Open only
    # a fresh, uniquely matching result in the host-reported transcript's session.
    transcript = Path(receipt['transcriptPath'])
    directory = transcript.with_suffix('') / 'tool-results'
    path = Path(receipt['path'])
    if (not transcript.is_absolute() or transcript.suffix != '.jsonl' or '..' in transcript.parts
            or path.parent != directory):
        raise TransferError('Invalid saved download result')
    server = re.sub(r'[^A-Za-z0-9_-]', '_', receipt['connection'])
    name_pattern = re.compile(r'mcp-' + re.escape(server) + r'-downloadFiles-(\d+)-[a-z0-9]+\.txt')
    fd = open_node(directory.anchor, directory=True)
    try:
        for component in directory.parts[1:]:
            child = open_node(component, fd, directory=True)
            os.close(fd)
            fd = child
        candidates = []
        with os.scandir(fd) as entries:
            for entry in entries:
                match = name_pattern.fullmatch(entry.name)
                if match and receipt['started'] <= int(match[1]) <= receipt['finished']:
                    candidates.append(entry.name)
                    if len(candidates) > 1:
                        break
        if candidates != [path.name]:
            raise TransferError('Saved result cannot be identified for this download')
        with os.fdopen(open_node(path.name, fd), 'rb') as result:
            info = os.fstat(result.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_nlink != 1 or info.st_size != receipt['size']
                    or not receipt['started'] <= info.st_ctime_ns // 1_000_000 <= receipt['finished']):
                raise TransferError('Incomplete saved download result')
            data = result.read()
            if len(data) != info.st_size or os.fstat(result.fileno()).st_ctime_ns != info.st_ctime_ns:
                raise TransferError('Saved download result changed while being read')
            value = json.loads(data)
    finally:
        os.close(fd)
    if not isinstance(value, dict) or not isinstance(value.get('base64'), str):
        raise TransferError('Saved result is missing archive bytes')
    return value['base64']


def main(operation, path):
    if not Path(path).is_absolute():
        raise TransferError('Use an absolute local path')
    if operation == 'pack':
        sys.stdout.write(pack_source(path))
    elif operation == 'check':
        if os.path.lexists(path):
            raise TransferError('Choose a new local download directory; the destination already exists')
    elif operation == 'save':
        save_archive(sys.stdin.buffer.read(), path)
    elif operation == 'save-result':
        receipt = json.loads(sys.stdin.buffer.read(32768))
        save_archive(saved_archive(receipt), path)
    else:
        raise TransferError('Unknown archive operation')


if __name__ == '__main__':
    try:
        main(*sys.argv[1:])
    except (ValueError, TransferError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(2)
    except OSError as error:
        print(error.strerror or 'Archive I/O failed', file=sys.stderr)
        sys.exit(2)
