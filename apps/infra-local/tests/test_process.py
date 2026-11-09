"""Run the actual supervisor against its own disposable host process."""

import json
import os
from pathlib import Path
import socket
import sys
import tempfile
import unittest

from compose import native


class ProcessSupervision(unittest.TestCase):
    def test_real_process_reuse_and_identity_guarded_stop(self):
        with tempfile.TemporaryDirectory() as directory, socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
            reservation.close()
            paths = native._Paths(Path(directory))
            component = native._Component(
                "infra-probe", port, "http", f"http://127.0.0.1:{port}", 10,
                [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
                Path(directory), {},
            )
            pid = None
            original = None
            try:
                self.assertTrue(native.start_component(paths, component))
                record_file = native._pid_file(paths, component.name)
                original = record_file.read_text()
                record = json.loads(original)
                pid = record if type(record) is int else record["pid"]
                self.assertIsInstance(record, dict, "a numeric PID cannot establish process identity")
                self.assertTrue(native.start_component(paths, component))
                self.assertEqual(native._component_pid(paths, component.name), pid)
                record_file.write_text(json.dumps({**record, "started_at": "a different process"}))
                native.stop_component(paths, component.name)
                os.kill(pid, 0)
                self.assertTrue(native._port_listening(port), "identity mismatch must not signal the process")
            finally:
                if original is not None:
                    native._pid_file(paths, component.name).write_text(original)
                    native.stop_component(paths, component.name)
                if pid is not None:
                    os.waitpid(pid, 0)
            self.assertFalse(native._port_listening(port))
