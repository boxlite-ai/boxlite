"""Temporary observer for the unchanged PR #2524 network-policy test."""
import asyncio
import functools
import json
import os
from pathlib import Path
import re
import shutil
import time

import pytest

OUT = Path('/tmp/pr2524-rootcause-network-observed')


def record(event, **fields):
    OUT.mkdir(exist_ok=True)
    with (OUT / 'events.jsonl').open('a') as stream:
        stream.write(json.dumps(dict(event=event, time_ns=time.time_ns(), **fields)) + '\n')


def preserve(box_id, phase):
    if not re.fullmatch(r'[A-Za-z0-9_-]+', box_id):
        return
    home = Path(os.environ['BOXLITE_HOME'])
    source = home / 'boxes' / box_id
    destination = OUT / f'{box_id}-{phase}-{time.time_ns()}'
    destination.mkdir(parents=True, exist_ok=True)
    if (source / 'logs').is_dir():
        shutil.copytree(source / 'logs', destination / 'logs', dirs_exist_ok=True)
    if (source / 'shim.stderr').is_file():
        shutil.copy2(source / 'shim.stderr', destination / 'shim.stderr')
    for capture in (source / 'sockets').glob('pr2524-network-*.pcap'):
        shutil.copy2(capture, destination / capture.name)


class RuntimeObserver:
    def __init__(self, inner):
        self.inner = inner
        self.probes = {}

    def __getattr__(self, name):
        return getattr(self.inner, name)

    async def create(self, *args, **kwargs):
        return BoxObserver(await self.inner.create(*args, **kwargs), self)

    async def get(self, *args, **kwargs):
        return BoxObserver(await self.inner.get(*args, **kwargs), self)

    async def remove(self, box_id, *args, **kwargs):
        preserve(box_id, 'before-remove')
        return await self.inner.remove(box_id, *args, **kwargs)


class BoxObserver:
    def __init__(self, inner, runtime):
        self.inner = inner
        self.runtime = runtime

    def __getattr__(self, name):
        return getattr(self.inner, name)

    @property
    def network(self):
        return NetworkObserver(self.inner.network, self.id)

    async def start(self):
        record('start', box=self.id)
        try:
            result = await self.inner.start()
        except BaseException as error:
            record('start-error', box=self.id, error=repr(error))
            preserve(self.id, 'start-error')
            raise
        record('started', box=self.id)
        return result

    async def stop(self):
        record('stop', box=self.id)
        result = await self.inner.stop()
        preserve(self.id, 'stopped')
        return result

    async def exec(self, command, args=None, **kwargs):
        if command != 'wget':
            return await self.inner.exec(command, args, **kwargs)
        number = self.runtime.probes.get(self.id, 0) + 1
        self.runtime.probes[self.id] = number
        record('probe-start', box=self.id, number=number, argv=[command, *args])
        execution = await self.inner.exec(command, args, **kwargs)
        return ExecutionObserver(execution, self, number, args[-1])


class NetworkObserver:
    def __init__(self, inner, box_id):
        self.inner, self.box_id = inner, box_id

    async def update_outbound(self, spec):
        record('policy-start', box=self.box_id, mode=spec.mode, rules=spec.allow_net)
        result = await self.inner.update_outbound(spec)
        record('policy-done', box=self.box_id, mode=spec.mode)
        return result


class ExecutionObserver:
    def __init__(self, inner, box, number, url):
        self.inner, self.box, self.number, self.url = inner, box, number, url

    def __getattr__(self, name):
        return getattr(self.inner, name)

    async def wait(self):
        result = await self.inner.wait()
        record('probe-result', box=self.box.id, number=self.number, exit_code=result.exit_code)
        if self.number == 9 and result.exit_code != 0:
            # Observe only AFTER the original final probe has already failed.
            # Its result is returned unchanged, so the original assertion still fails.
            try:
                await asyncio.wait_for(self.diagnose(), timeout=20)
            except Exception as error:
                record('diagnostic-error', error=repr(error))
        return result

    async def diagnose(self):
        for command, args in [
            ('sh', ['-c', 'ip neigh; ip route; ip -s link; cat /proc/net/tcp; cat /proc/sys/net/ipv4/neigh/eth0/retrans_time_ms']),
            ('wget', ['-q', '-T', '10', '-O', '-', self.url]),
        ]:
            execution = await self.box.inner.exec(command, args)
            stdout = ''.join([chunk async for chunk in execution.stdout()])
            stderr = ''.join([chunk async for chunk in execution.stderr()])
            result = await execution.wait()
            record('after-failure', command=command, stdout=stdout, stderr=stderr, exit_code=result.exit_code)


@pytest.hookimpl(trylast=True)
def pytest_collection_modifyitems(items):
    for item in items:
        if item.name != 'test_network_policy_live_traffic_and_restart':
            continue
        original = item.obj

        @functools.wraps(original)
        async def observed(shared_runtime, _original=original):
            start_server = asyncio.start_server

            async def observed_server(callback, *args, **kwargs):
                async def reply(reader, writer):
                    peer = writer.get_extra_info('peername')
                    record('server-accepted', peer=peer)
                    try:
                        await callback(reader, writer)
                    finally:
                        record('server-finished', peer=peer)
                return await start_server(reply, *args, **kwargs)

            asyncio.start_server = observed_server
            try:
                return await _original(RuntimeObserver(shared_runtime))
            finally:
                asyncio.start_server = start_server

        item.obj = observed
