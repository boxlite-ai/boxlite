#!/usr/bin/env python3
"""Check public production OAuth prerequisites without credentials or tenant writes."""
import json
import os
from datetime import datetime, timezone
from pathlib import Path
import re
import urllib.error
import urllib.request

from boxlite import MCP_URL, REPO

ISSUER = 'https://auth.boxlite.ai/'
RESOURCE_METADATA = 'https://api.boxlite.ai/.well-known/oauth-protected-resource/mcp'
SERVER_METADATA = ISSUER + '.well-known/oauth-authorization-server'
MAX_BODY = 65536


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, url):
        return None


def request_public(opener, url, data=None):
    request = urllib.request.Request(url, data=data, headers={
        'Accept': 'application/json, text/event-stream', 'Content-Type': 'application/json',
    })
    try:
        response = opener.open(request, timeout=15)
    except urllib.error.HTTPError as error:
        response = error
    with response:
        body = response.read(MAX_BODY + 1)
        if len(body) > MAX_BODY:
            raise ValueError('Response exceeds the public metadata limit')
        return response.code, response.headers, body


def read_document(opener, url):
    status, _, body = request_public(opener, url)
    if status != 200:
        raise ValueError('Metadata did not return HTTP 200')
    document = json.loads(body)
    if not isinstance(document, dict):
        raise ValueError('Metadata must be a JSON object')
    return document


def includes(document, field, expected):
    values = document.get(field)
    return isinstance(values, list) and all(isinstance(value, str) for value in values) and expected in values


def preflight():
    # Fixed public destinations: never follow URLs supplied by metadata or send host credentials.
    opener = urllib.request.build_opener(NoRedirect())
    checks = []

    def record(name, passed, remedy):
        checks.append({'check': name, 'status': 'passed' if passed else 'blocked',
                       'next_step': '' if passed else remedy})

    try:
        resource = read_document(opener, RESOURCE_METADATA)
        expected_scopes = json.loads((REPO / 'apps/infra/bootstrap/auth0/mcp-clients.json').read_text())['scopes']
        scopes = resource.get('scopes_supported')
        record('resource', resource.get('resource') == MCP_URL, 'Align MCP_RESOURCE_URL with the production /mcp URL.')
        record('authorization_server', resource.get('authorization_servers') == [ISSUER],
               'Align the API issuer with the production Auth0 issuer.')
        record('scopes', isinstance(scopes, list) and all(isinstance(scope, str) for scope in scopes)
               and set(scopes) == set(expected_scopes), 'Align deployed MCP scopes with the reviewed client scope list.')
    except (OSError, ValueError):
        record('resource_metadata', False, 'Check resource metadata availability, HTTP status, size, and JSON shape.')

    try:
        server = read_document(opener, SERVER_METADATA)
        for field, expected in (
            ('issuer', ISSUER), ('authorization_endpoint', ISSUER + 'authorize'),
            ('token_endpoint', ISSUER + 'oauth/token'),
        ):
            record(field, server.get(field) == expected, 'Verify the production Auth0 discovery configuration.')
        for field in ('client_id_metadata_document_supported', 'authorization_response_iss_parameter_supported'):
            record(field, server.get(field) is True, 'Apply the reviewed Auth0 MCP tenant configuration.')
        for field, value in (
            ('token_endpoint_auth_methods_supported', 'none'), ('code_challenge_methods_supported', 'S256'),
            ('response_types_supported', 'code'), ('grant_types_supported', 'authorization_code'),
        ):
            record(field, includes(server, field, value), 'Verify public-client authorization-code and PKCE support.')
    except (OSError, ValueError):
        record('server_metadata', False, 'Check authorization-server metadata availability, HTTP status, size, and JSON shape.')

    try:
        body = json.dumps({'jsonrpc': '2.0', 'id': 1, 'method': 'initialize', 'params': {
            'protocolVersion': '2025-03-26', 'capabilities': {},
            'clientInfo': {'name': 'boxlite-oauth-preflight', 'version': '0.2.0'},
        }}).encode()
        status, headers, _ = request_public(opener, MCP_URL, body)
        challenge = headers.get('WWW-Authenticate', '')
        metadata = re.search(r'\bresource_metadata="([^"]+)"', challenge, re.I)
        record('unauthenticated_challenge', status == 401 and bool(re.match(r'^Bearer\s', challenge, re.I))
               and metadata is not None and metadata.group(1) == RESOURCE_METADATA,
               'Require a 401 Bearer challenge pointing to the exact protected resource metadata URL.')
    except (OSError, ValueError):
        record('unauthenticated_challenge', False, 'Check the unauthenticated MCP response without supplying credentials.')

    return {
        'checked_at': datetime.now(timezone.utc).isoformat(), 'endpoint': MCP_URL,
        'status': 'public_preflight_passed' if all(check['status'] == 'passed' for check in checks) else 'blocked',
        'checks': checks,
        'not_verified': ['Auth0 client registration and grants', 'deployed login Action and email verification',
                         'native host consent and callback', 'user onboarding and default organization',
                         'token renewal and revocation', 'live allowed/denied tool calls', 'directory approval'],
    }


def main():
    os.umask(0o077)
    result = preflight()
    output = REPO / 'target/plugins/evidence/oauth-preflight.json'
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2) + '\n')
    output.chmod(0o600)
    print('OAuth public preflight: ' + result['status'])
    for check in result['checks']:
        if check['status'] != 'passed':
            print('- ' + check['check'] + ': ' + check['next_step'])
    print('Native OAuth login and release readiness remain unverified. Report: ' + str(output))
    return 0 if result['status'] == 'public_preflight_passed' else 1


if __name__ == '__main__':
    raise SystemExit(main())
