#!/usr/bin/env python3
"""Move files through existing MCP tools without exposing archive base64 to the model."""
import argparse
import base64
import binascii
import json
import os
from pathlib import Path
import sys

from transfer_archive import Archive, MAX_BYTES
from transfer_hosts import CodexHost, ClaudeHost, TransferError


def upload(client, box, source, destination):
    archive = Archive.snapshot(source).encode()
    result = client.call('uploadFiles', {'box_id': box, 'path': destination,
                                        'body_base64': base64.b64encode(archive).decode('ascii')})
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
        if len(content) != 1 or content[0].get('type') != 'text':
            raise TransferError('MCP download did not return its archive object')
        try:
            value = json.loads(content[0]['text'])
        except (ValueError, KeyError):
            raise TransferError('MCP download returned malformed archive metadata') from None
    if not isinstance(value, dict) or not isinstance(value.get('base64'), str):
        raise TransferError('MCP download is missing archive bytes')
    encoded = value['base64']
    if len(encoded) > 4 * ((MAX_BYTES + 2) // 3):
        raise TransferError('MCP archive exceeds 8 MiB')
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (binascii.Error, ValueError):
        raise TransferError('MCP download returned invalid base64') from None
    Archive.decode(raw).save(destination)
    return {'operation': 'download', 'status': 'completed', 'box_id': box,
            'destination': str(Path(destination).absolute())}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--host', choices=('codex', 'claude'), required=True)
    parser.add_argument('--server', required=True, help='Existing selected host MCP connection name')
    parser.add_argument('--mcp-config', help='Existing Claude MCP config path; passed to Claude without reading it')
    parser.add_argument('--plugin-dir', help='Claude plugin directory, when not installed persistently')
    parser.add_argument('operation', choices=('upload', 'download'))
    parser.add_argument('--box', required=True)
    parser.add_argument('--source', required=True)
    parser.add_argument('--destination', required=True)
    args = parser.parse_args()
    try:
        if args.host == 'codex':
            if args.mcp_config or args.plugin_dir:
                raise TransferError('Claude configuration options cannot be used with Codex')
            client = CodexHost(args.server)
        else:
            client = ClaudeHost(args.server, mcp_config=args.mcp_config, plugin_dir=args.plugin_dir)
        with client:
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
