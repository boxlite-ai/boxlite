"""REST regression coverage for Docker-style privileged options."""
from __future__ import annotations

import asyncio
import json

import boxlite
import pytest

from conftest import drain


async def _read_privilege_state(box) -> dict[str, bool]:
    script = r"""
import json

status = {}
with open('/proc/self/status', encoding='ascii') as stream:
    for line in stream:
        if ':' in line:
            key, value = line.split(':', 1)
            status[key] = value.strip()

last_cap = int(open('/proc/sys/kernel/cap_last_cap', encoding='ascii').read())
effective = int(status['CapEff'], 16)
required = (1 << (last_cap + 1)) - 1
sysctl_path = '/proc/sys/net/ipv4/ip_forward'
sysctl_writable = False
try:
    with open(sysctl_path, 'r+', encoding='ascii') as stream:
        value = stream.read()
        stream.seek(0)
        stream.write(value)
        stream.flush()
    sysctl_writable = True
except OSError:
    pass
cgroup_writable = False
with open('/proc/self/mountinfo', encoding='ascii') as stream:
    for line in stream:
        fields = line.split(' - ', 1)[0].split()
        if len(fields) > 5 and fields[4] == '/sys/fs/cgroup':
            cgroup_writable = 'rw' in fields[5].split(',')
            break

print(json.dumps({
    'all_capabilities': (effective & required) == required,
    'sysctl_writable': sysctl_writable,
    'cgroup_writable': cgroup_writable,
}))
"""
    execution = await box.exec('python3', ['-c', script])
    stdout, stderr = await drain(execution)
    result = await asyncio.wait_for(execution.wait(), timeout=30)
    assert result.exit_code == 0, f'privileged probe failed: {stderr}'
    return json.loads(stdout)


@pytest.mark.asyncio
async def test_rest_privileged_shape_and_capability_shape_are_distinct(rt, image):
    """PR 646 must normalize privileged mode without conflating cap_add=ALL."""
    privileged = await rt.create(
        boxlite.BoxOptions(
            image=image,
            auto_remove=True,
            advanced=boxlite.AdvancedBoxOptions(privileged=True),
        )
    )
    capabilities_only = await rt.create(
        boxlite.BoxOptions(
            image=image,
            auto_remove=True,
            advanced=boxlite.AdvancedBoxOptions(
                capabilities=boxlite.ContainerCapabilities(add=['ALL']),
            ),
        )
    )

    try:
        privileged_state = await _read_privilege_state(privileged)
        capabilities_state = await _read_privilege_state(capabilities_only)

        assert privileged_state == {
            'all_capabilities': True,
            'sysctl_writable': True,
            'cgroup_writable': True,
        }
        assert capabilities_state == {
            'all_capabilities': True,
            'sysctl_writable': False,
            'cgroup_writable': False,
        }
    finally:
        await asyncio.gather(
            rt.remove(privileged.id, force=True),
            rt.remove(capabilities_only.id, force=True),
            return_exceptions=True,
        )
