#!/usr/bin/env python3
"""Move files through existing MCP tools without exposing archive base64 to the model."""
import argparse
import base64
import binascii
import json
import os
from pathlib import Path
import sys

from transfer_archive import Archive
from transfer_hosts import CodexHost, TransferError


def pack_source(source):
    archive = Archive.snapshot(source).encode()
    return base64.b64encode(archive).decode('ascii')


def upload(client, box, source, destination):
    result = client.call('uploadFiles', {'box_id': box, 'path': destination,
                                        'body_base64': pack_source(source)})
    content = result.get('content')
    # The existing server represents a successful, empty REST upload response as HTTP 204.
    if (not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict)
            or content[0].get('type') != 'text' or content[0].get('text') != 'HTTP 204'):
        raise TransferError('uploadFiles returned no HTTP 204 acknowledgment; completion is unknown')
    return {'operation': 'upload', 'status': 'completed', 'box_id': box, 'destination': destination}


def download(client, box, source, destination):
    if os.path.lexists(destination):
        raise TransferError('Choose a new local download directory; the destination already exists')
    result = client.call('downloadFiles', {'box_id': box, 'path': source})
    value = result.get('structuredContent')
    if value is None:
        content = result.get('content', [])
        if (not isinstance(content, list) or len(content) != 1 or not isinstance(content[0], dict)
                or content[0].get('type') != 'text' or not isinstance(content[0].get('text'), str)):
            raise TransferError('MCP download did not return its archive object')
        try:
            value = json.loads(content[0]['text'])
        except ValueError:
            raise TransferError('MCP download returned malformed archive metadata') from None
    if not isinstance(value, dict) or not isinstance(value.get('base64'), str):
        raise TransferError('MCP download is missing archive bytes')
    save_archive(value['base64'], destination)
    return {'operation': 'download', 'status': 'completed', 'box_id': box,
            'destination': str(Path(destination).absolute())}


def save_archive(encoded, destination):
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise TransferError('MCP download returned invalid base64') from None
    Archive.decode(raw).save(destination)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=('codex',), required=True)
    parser.add_argument('--server', required=True, help='Existing selected host MCP connection name')
    parser.add_argument('operation', choices=('upload', 'download'))
    parser.add_argument('--box', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    try:
        with CodexHost(args.server) as client:
            operation = upload if args.operation == 'upload' else download
            result = operation(client, args.box, args.source, args.destination)
        print(json.dumps(result, separators=(',', ':')))
        return 0
    except Exception as error:
        # Raw transport exceptions and tool results can contain credentials or archive data.
        detail = str(error) if isinstance(error, (TransferError, ValueError)) else type(error).__name__
        print('BoxLite file transfer failed: ' + detail + '. No automatic retry.', file=sys.stderr)
        return 1


if __name__ == '__main__':
    raise SystemExit(main())
