"""Archive I/O for an authorized Claude transfer. File bytes use standard streams."""
import json
import os
from pathlib import Path
import re
import sys

from transfer import TransferError, pack_source, save_archive


def saved_archive(receipt):
    # A server can imitate a persistence notice. Select its file from the host-reported session.
    transcript = Path(receipt['transcriptPath'])
    directory = transcript.with_suffix('') / 'tool-results'
    path = Path(receipt['path'])
    if (not transcript.is_absolute() or transcript.suffix != '.jsonl' or '..' in transcript.parts
            or not path.is_absolute() or '..' in path.parts):
        raise TransferError('Invalid saved download result')
    server = re.sub(r'[^A-Za-z0-9_-]', '_', receipt['connection'])
    name_pattern = re.compile(r'mcp-' + re.escape(server) + r'-downloadFiles-(\d+)-[a-z0-9]+\.txt')
    candidate = None
    for entry in directory.glob('*.txt'):
        match = name_pattern.fullmatch(entry.name)
        if match and receipt['started'] <= int(match[1]) <= receipt['finished']:
            if candidate is not None:
                raise TransferError('Saved result cannot be identified for this download')
            candidate = entry
    if candidate is None or candidate.resolve() != path.resolve():
        raise TransferError('Saved result cannot be identified for this download')
    value = json.loads(candidate.read_bytes())
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
