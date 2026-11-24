"""Public discovery is a prerequisite, never proof of an authenticated workflow."""
import copy
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import sys
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'scripts/plugins'))
import oauth_preflight as preflight


class Response(io.BytesIO):
    def __init__(self, body, code=200, headers=None):
        super().__init__(body)
        self.code = code
        self.headers = headers or {}


class PublicPreflightTests(unittest.TestCase):
    def setUp(self):
        scopes = json.loads((preflight.REPO / 'apps/infra/bootstrap/auth0/mcp-clients.json').read_text())['scopes']
        self.resource = {'resource': preflight.MCP_URL, 'authorization_servers': [preflight.ISSUER],
                         'scopes_supported': scopes}
        self.server = {
            'issuer': preflight.ISSUER, 'authorization_endpoint': preflight.ISSUER + 'authorize',
            'token_endpoint': preflight.ISSUER + 'oauth/token', 'client_id_metadata_document_supported': True,
            'authorization_response_iss_parameter_supported': True,
            'token_endpoint_auth_methods_supported': ['none'], 'code_challenge_methods_supported': ['S256'],
            'response_types_supported': ['code'], 'grant_types_supported': ['authorization_code'],
        }
        self.challenge_status = 401
        self.challenge = 'Bearer resource_metadata="' + preflight.RESOURCE_METADATA + '"'
        self.requests = []

    def open(self, request, timeout):
        self.requests.append(request)
        self.assertEqual(timeout, 15)
        if request.full_url == preflight.RESOURCE_METADATA:
            return Response(json.dumps(self.resource).encode())
        if request.full_url == preflight.SERVER_METADATA:
            return Response(json.dumps(self.server).encode())
        self.assertEqual(request.full_url, preflight.MCP_URL)
        self.assertEqual(json.loads(request.data)['method'], 'initialize')
        return Response(b'{}', self.challenge_status, {'WWW-Authenticate': self.challenge})

    def run_preflight(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=self.open):
            return preflight.preflight()

    def test_complete_discovery_does_not_claim_login_or_release_ready(self):
        with patch.dict(os.environ, {'BOXLITE_API_KEY': 'synthetic-must-not-send'}):
            result = self.run_preflight()
        self.assertEqual(result['status'], 'public_preflight_passed')
        self.assertEqual(len(result['checks']), 13)
        self.assertIn('native host consent and callback', result['not_verified'])
        self.assertIn('directory approval', result['not_verified'])
        self.assertEqual(len(self.requests), 3)
        for request in self.requests:
            self.assertIsNone(request.get_header('Authorization'))
            self.assertNotIn('synthetic-must-not-send', repr(request.headers) + repr(request.data))

    def test_missing_or_mistyped_capabilities_fail_closed(self):
        original = copy.deepcopy(self.server)
        for field in original:
            for invalid in (None, False, 'true', []):
                with self.subTest(field=field, invalid=invalid):
                    self.server = {**original, field: invalid}
                    result = self.run_preflight()
                    self.assertEqual(result['status'], 'blocked')
                    self.assertIn(field, [check['check'] for check in result['checks'] if check['status'] == 'blocked'])

    def test_wrong_resource_issuer_and_scope_drift_are_reported(self):
        self.resource.update(resource='https://other.example/mcp', authorization_servers=['http://127.0.0.1/private'],
                             scopes_supported=['admin:all'])
        result = self.run_preflight()
        blocked = {check['check'] for check in result['checks'] if check['status'] == 'blocked'}
        self.assertEqual(blocked, {'resource', 'authorization_server', 'scopes'})
        self.assertEqual([request.full_url for request in self.requests],
                         [preflight.RESOURCE_METADATA, preflight.SERVER_METADATA, preflight.MCP_URL])

    def test_unauthenticated_success_or_incorrect_challenge_is_blocked(self):
        for status, challenge in ((200, self.challenge), (401, ''), (403, self.challenge),
                                  (401, 'Bearer resource_metadata="https://other.example/metadata"')):
            with self.subTest(status=status, challenge=challenge):
                self.challenge_status, self.challenge = status, challenge
                checks = self.run_preflight()['checks']
                self.assertEqual(checks[-1]['status'], 'blocked')

    def test_network_errors_are_redacted_and_never_retried(self):
        with patch('urllib.request.OpenerDirector.open', side_effect=urllib.error.URLError('private-detail')) as opened:
            result = preflight.preflight()
        self.assertEqual(result['status'], 'blocked')
        self.assertEqual(opened.call_count, 3)
        self.assertEqual(len(result['checks']), 3)
        self.assertNotIn('private-detail', json.dumps(result))

    def test_metadata_rejects_wrong_status_shape_encoding_and_size(self):
        opener = urllib.request.build_opener(preflight.NoRedirect())
        for code, body in ((302, b'{}'), (401, b'{}'), (200, b'[]'), (200, b'null'), (200, b'bad-json'),
                           (200, b'\xff'), (200, b' ' * (preflight.MAX_BODY + 1))):
            with self.subTest(code=code, body_length=len(body)):
                with patch.object(opener, 'open', return_value=Response(body, code)):
                    with self.assertRaises(ValueError):
                        preflight.read_document(opener, preflight.SERVER_METADATA)
        body = b'{}' + b' ' * (preflight.MAX_BODY - 2)
        with patch.object(opener, 'open', return_value=Response(body)):
            self.assertEqual(preflight.read_document(opener, preflight.SERVER_METADATA), {})

    def test_http_boundary_does_not_follow_redirects_and_reads_401_challenge(self):
        visited = []
        challenge = self.challenge

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                visited.append(self.path)
                if self.path == '/redirect':
                    self.send_response(302)
                    self.send_header('Location', '/must-not-visit')
                else:
                    self.send_response(401)
                    self.send_header('WWW-Authenticate', challenge)
                self.end_headers()
                self.wfile.write(b'{}')

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), preflight.NoRedirect())
            url = 'http://127.0.0.1:' + str(server.server_port)
            status, _, _ = preflight.request_public(opener, url + '/redirect')
            self.assertEqual(status, 302)
            status, headers, _ = preflight.request_public(opener, url + '/protected')
            self.assertEqual(status, 401)
            self.assertEqual(headers['WWW-Authenticate'], challenge)
            self.assertEqual(visited, ['/redirect', '/protected'])
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=5)
