"""E2E P0 (secret hygiene): platform secrets never surface inside the guest.

Requirement (Sandbox platform §5.6 / §12.4): the real secret value and the
Core→runner access credential must never be visible to the workload — not in
the process environment, not in `/proc/1/environ`, not on disk in an obvious
config path. The guest only ever sees the *placeholder*; the real value is
injected host-side by the MITM proxy on outbound HTTPS.

Scope note: the substitution mechanism itself (placeholder → real value on the
wire) is exercised at the FFI layer in
`sdks/python/tests/test_secret_substitution.py`. This case pins the
platform-level *non-leak invariant* over the REST path the assistant actually
uses: whatever the runner injects into the guest, it must not include a raw
secret value or the caller's API token.
"""

from __future__ import annotations

import asyncio

import pytest
from conftest import drain

import boxlite

# A value that is easy to grep for and would never occur by accident.
SECRET_SENTINEL = "s3cr3t-e2e-DO-NOT-LEAK-9f13ab"

# What the guest is supposed to see instead. The runtime derives both from
# `Secret.name`: the placeholder defaults to `<BOXLITE_SECRET:{name}>` and is
# exported under `BOXLITE_SECRET_{NAME}` (Secret::env_pair, applied in
# litebox/init/tasks/container_rootfs.rs). Asserting the placeholder IS present
# is what makes the non-leak assertions meaningful — without it a build that
# dropped `secrets=` on the floor entirely would pass this test.
SECRET_NAME = "e2e_probe"
SECRET_PLACEHOLDER = f"<BOXLITE_SECRET:{SECRET_NAME}>"
SECRET_ENV_KEY = f"BOXLITE_SECRET_{SECRET_NAME.upper()}"

# Dump every guest-visible surface a leaked secret could land in, one blob.
_DUMP = (
    "import os, sys\n"
    "buf = []\n"
    "buf.append('ENV\\n')\n"
    "for k, v in os.environ.items():\n"
    "    buf.append('%s=%s\\n' % (k, v))\n"
    "try:\n"
    "    with open('/proc/1/environ', 'rb') as f:\n"
    "        buf.append('PID1\\n' + f.read().replace(b'\\0', b'\\n').decode('utf-8', 'replace'))\n"
    "except Exception as e:\n"
    "    buf.append('PID1_ERR:%s\\n' % e)\n"
    "def _read(path):\n"
    "    try:\n"
    "        with open(path, 'r', errors='replace') as f:\n"
    "            buf.append('FILE %s\\n%s\\n' % (path, f.read()))\n"
    "    except Exception:\n"
    "        pass\n"
    "for root in ('/etc/environment', '/root/.boxlite', '/run/secrets'):\n"
    "    if os.path.isdir(root):\n"
    "        for dp, _dirs, files in os.walk(root):\n"
    "            for fn in files:\n"
    "                _read(os.path.join(dp, fn))\n"
    "    elif os.path.exists(root):\n"
    "        _read(root)\n"
    "sys.stdout.write(''.join(buf))\n"
)


@pytest.mark.asyncio
async def test_secret_value_and_api_token_never_visible_in_guest(rt, image, e2e_auth):
    """Create a box carrying a secret, then prove neither the secret value nor
    the platform API token appears anywhere the guest can read."""
    b = await rt.create(
        boxlite.BoxOptions(
            image=image,
            auto_remove=True,
            secrets=[
                boxlite.Secret(
                    name=SECRET_NAME,
                    value=SECRET_SENTINEL,
                    hosts=["api.openai.com"],
                )
            ],
        )
    )
    try:
        ex = await b.exec("python3", ["-c", _DUMP], None)
        out, err = await drain(ex)
        rc = await asyncio.wait_for(ex.wait(), timeout=30)
        assert rc.exit_code == 0, (
            f"dump process failed rc={rc.exit_code} stderr={err!r}"
        )

        # 0) Positive controls. Both negative assertions below are satisfied by
        #    a box that never received the secret at all, so first prove the
        #    surfaces were really inspected and the secret really was wired in.
        assert "\nPID1\n" in out, (
            "/proc/1/environ was not readable, so the strongest leak surface "
            f"went uninspected → {out[:400]!r}"
        )
        assert f"{SECRET_ENV_KEY}={SECRET_PLACEHOLDER}" in out, (
            f"expected the guest to carry {SECRET_ENV_KEY}={SECRET_PLACEHOLDER}; "
            "without it the secret was never injected and the non-leak "
            f"assertions below prove nothing → {out[:400]!r}"
        )

        # 1) The real secret value must never reach the guest.
        assert SECRET_SENTINEL not in out, (
            "secret VALUE leaked into a guest-visible surface (env/proc/disk); "
            "the guest must only ever see the placeholder"
        )
        # 2) The Core→runner access token must never be injected into the guest.
        token = e2e_auth.token
        assert token and token not in out, (
            "platform access token leaked into the guest environment"
        )
    finally:
        await rt.remove(b.id, force=True)
