"""Contract checks for the bounded MCP release-acceptance client."""
import importlib.util
import io
import json
from pathlib import Path
import unittest
from unittest.mock import patch
import urllib.error

spec = importlib.util.spec_from_file_location('acceptance', Path(__file__).resolve().parents[2] / 'scripts/plugins/cloud_acceptance.py')
acceptance = importlib.util.module_from_spec(spec)
spec.loader.exec_module(acceptance)


class Response(io.BytesIO):
    def __init__(self, body, content_type='application/json'):
        super().__init__(body)
        self.headers = {'Content-Type': content_type}


class CloudAcceptanceTests(unittest.TestCase):
    def setUp(self):
        self.client = acceptance.McpClient('synthetic-test-key')

    def test_empty_or_header_injected_key_is_rejected_before_network(self):
        for key in ('', None, 'key\r\nInjected: value', ' '):
            with self.assertRaises(ValueError):
                acceptance.McpClient(key)

    def test_request_is_bound_to_production_and_token_is_not_in_body(self):
        response = Response(b'{"jsonrpc":"2.0","id":1,"result":{"tools":[]}}')
        with patch.object(self.client.opener, 'open', return_value=response) as opened:
            self.assertEqual(self.client.request('tools/list'), {'tools': []})
        request = opened.call_args.args[0]
        self.assertEqual(request.full_url, acceptance.ENDPOINT)
        self.assertNotIn(b'synthetic-test-key', request.data)
        self.assertEqual(request.get_header('Authorization'), 'Bearer synthetic-test-key')

    def test_protocol_errors_and_wrong_request_ids_fail(self):
        for body in (b'{"id":1,"error":{"code":-1}}', b'{"id":999,"result":{}}'):
            self.client.sequence = 0
            with patch.object(self.client.opener, 'open', return_value=Response(body)):
                with self.assertRaisesRegex(RuntimeError, 'protocol failure'):
                    self.client.request('tools/list')

    def test_sse_result_matches_id_and_ignores_notifications(self):
        body = b'data: {"method":"notifications/progress"}\n\ndata: {"id":1,"result":{"tools":[]}}\n\n'
        with patch.object(self.client.opener, 'open', return_value=Response(body, 'text/event-stream')):
            self.assertEqual(self.client.request('tools/list'), {'tools': []})

    def test_http_denial_is_not_retried_or_reauthenticated(self):
        error = urllib.error.HTTPError(acceptance.ENDPOINT, 401, 'synthetic-private-detail', {}, None)
        with patch.object(self.client.opener, 'open', side_effect=error) as opened:
            with self.assertRaisesRegex(RuntimeError, 'HTTP 401') as caught:
                self.client.request('tools/list')
        self.assertEqual(opened.call_count, 1)
        self.assertNotIn('synthetic-private-detail', str(caught.exception))

    def test_tool_error_cannot_be_reported_as_success(self):
        error = {'isError': True, 'content': [{'type': 'text', 'text': 'operation denied'}]}
        with patch.object(self.client, 'request', return_value=error):
            with self.assertRaisesRegex(RuntimeError, 'unexpected MCP error'):
                self.client.call('createBox', {})
            self.assertIs(self.client.call('createBox', {}, error=True), error)

    def test_redirects_cannot_forward_credentials(self):
        handler = acceptance.NoRedirect()
        with self.assertRaisesRegex(RuntimeError, 'redirect refused'):
            handler.redirect_request(None, None, 307, '', {}, 'https://other.example')

    def test_archive_contains_the_exact_uploaded_file(self):
        import base64
        import tarfile
        content = b'preserve this content\n'
        with tarfile.open(fileobj=io.BytesIO(base64.b64decode(acceptance.archive_bytes(content)))) as archive:
            self.assertEqual(archive.getnames(), ['message.txt'])
            self.assertEqual(archive.extractfile('message.txt').read(), content)
