"""External development stores share one connection selection across local processes."""

import asyncio
import os
import subprocess
import tempfile
import unittest
from dataclasses import replace
from pathlib import Path
from unittest.mock import AsyncMock, patch

from compose import native, orchestrator
from compose.config import InfraConfig


class ExternalStores(unittest.TestCase):
    def setUp(self):
        self.env = {
            'BOXLITE_LOCAL_EXTERNAL_STORES': '1',
            'DB_HOST': 'postgres.test', 'DB_PORT': '5434', 'DB_USERNAME': 'tester',
            'DB_PASSWORD': 'db-test', 'DB_DATABASE': 'app_demo',
            'REDIS_HOST': 'redis.test', 'REDIS_PORT': '6381',
            'REDIS_USERNAME': 'cache_user', 'REDIS_PASSWORD': 'cache-test',
        }
        with patch.dict(os.environ, self.env, clear=True):
            self.cfg = InfraConfig.load()

    def test_up_selects_only_local_services_and_resolves_their_dependencies(self):
        with patch.object(orchestrator, 'up', new_callable=AsyncMock) as up:
            asyncio.run(native._ensure_l1_async(self.cfg))
        selected = up.await_args.args[1]
        ordered = {name for layer in orchestrator.topo_sort(selected) for name in layer}
        self.assertTrue({'postgres', 'redis', 'pgadmin'}.isdisjoint(ordered))
        self.assertIn('rustfs', ordered)
        self.assertIn('caddy', ordered)
        self.assertNotIn('pgadmin', selected['caddy'].cmd(self.cfg)[-1])

    def test_api_proxy_and_seed_use_external_connections(self):
        with tempfile.TemporaryDirectory() as root:
            cfg = replace(self.cfg, repo_root=Path(root))
            p = native._paths(cfg)
            p.apps.mkdir()
            (p.apps / '.env').write_text('DB_HOST=127.0.0.1\nREDIS_PORT=26379\n')
            processes = native._components(p, cfg)
        for key in self.env:
            if key.startswith('DB_') or key.startswith('REDIS_'):
                self.assertEqual(processes['api'].env[key], self.env[key])
            if key.startswith('REDIS_'):
                self.assertEqual(processes['proxy'].env[key], self.env[key])
        with patch.object(subprocess, 'run') as run:
            native._psql(cfg, 'SELECT 1')
        self.assertEqual(run.call_args.args[0], ['psql', '-h', 'postgres.test', '-p', '5434', '-U', 'tester', '-d', 'app_demo', '-c', 'SELECT 1'])
        self.assertEqual(run.call_args.kwargs['env']['PGPASSWORD'], 'db-test')

    def test_external_stores_require_a_named_database(self):
        with patch.dict(os.environ, {**self.env, 'DB_DATABASE': ''}, clear=True):
            with self.assertRaisesRegex(ValueError, 'DB_DATABASE'):
                InfraConfig.load()

    def test_reset_cannot_wipe_remote_rows_or_local_boxes(self):
        with patch.object(native, '_stop_l2_and_wipe_runner') as stop, patch.object(native, '_psql') as sql:
            for hard in [False, True]:
                self.assertNotEqual(native.reset(self.cfg, hard=hard), 0)
        stop.assert_not_called()
        sql.assert_not_called()
