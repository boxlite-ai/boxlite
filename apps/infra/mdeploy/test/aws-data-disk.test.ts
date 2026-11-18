import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { awsDataDiskSetup } from '../stack/providers/aws/data-disk.ts'

const volumeId = 'vol-0123456789abcdef0'
const fixture = (
  options: { filesystem?: string; signatures?: string; oldState?: boolean; root?: boolean; missing?: boolean } = {},
) => {
  const dir = mkdtempSync(join(tmpdir(), 'boxlite-ebs-'))
  const bin = join(dir, 'bin'),
    sys = join(dir, 'sys'),
    dev = join(dir, 'dev'),
    home = join(dir, 'home')
  for (const path of [bin, sys, dev, home]) mkdirSync(path)
  const device = join(dev, 'nvme7n1')
  for (const [name, serial] of [
    ['nvme0n1', 'volfffffffffffffffff'],
    ['nvme7n1', volumeId.replace('-', '')],
  ]) {
    mkdirSync(join(sys, name, 'device'), { recursive: true })
    writeFileSync(join(sys, name, 'device/serial'), options.missing ? 'unassigned' : serial)
    writeFileSync(join(dev, name), '')
  }
  const log = join(dir, 'commands')
  writeFileSync(log, '')
  writeFileSync(join(dir, 'filesystem'), options.filesystem ?? '')
  writeFileSync(join(dir, 'fstab'), '')
  if (options.oldState) writeFileSync(join(home, 'boxes.db'), 'existing state')
  const commands: Record<string, string> = {
    blockdev: 'printf "%s\\n" 107374182400',
    lsblk: options.root ? 'printf "/\\n"' : 'exit 0',
    mountpoint: '[ -f "$FAKE_STATE/mounted" ]',
    findmnt: 'cat "$FAKE_STATE/mounted"',
    readlink: `exec "${process.execPath}" -e 'console.log(require("node:fs").realpathSync(process.argv[1]))' "$2"`,
    blkid:
      'if [ "$4" = TYPE ]; then value=$(cat "$FAKE_STATE/filesystem"); [ -n "$value" ] || exit 2; printf "%s\\n" "$value"; else printf "1234-abcd\\n"; fi',
    wipefs: 'printf "%s" "$FAKE_SIGNATURES"',
    'mkfs.ext4': 'printf "format %s\\n" "$2" >> "$FAKE_STATE/commands"; printf ext4 > "$FAKE_STATE/filesystem"',
    mount: 'printf "mount %s\\n" "$1" >> "$FAKE_STATE/commands"; printf "%s\\n" "$1" > "$FAKE_STATE/mounted"',
    sleep: 'printf "sleep\\n" >> "$FAKE_STATE/commands"',
  }
  for (const [name, body] of Object.entries(commands))
    writeFileSync(join(bin, name), '#!/bin/bash\nset -eu\n' + body + '\n', { mode: 0o755 })
  const script =
    'set -euo pipefail\n' +
    awsDataDiskSetup({
      volumeId,
      home,
      sysBlock: sys,
      devices: dev,
      link: join(dir, 'data-link'),
      fstab: join(dir, 'fstab'),
    })
  return {
    dir,
    home,
    device,
    run: () =>
      spawnSync('bash', ['-c', script], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: bin + ':' + process.env.PATH,
          FAKE_STATE: dir,
          FAKE_SIGNATURES: options.signatures ?? '',
        },
      }),
    log: () => readFileSync(log, 'utf8'),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}
test('EBS boot selects the assigned serial and mounts idempotently without formatting another disk', () => {
  const host = fixture()
  try {
    const first = host.run()
    assert.equal(first.status, 0, first.stderr)
    assert.equal(host.run().status, 0)
    assert.equal(host.log(), 'format ' + host.device + '\nmount ' + host.device + '\n')
    assert.equal(readlinkSync(join(host.dir, 'data-link')), host.device)
    assert.equal(readFileSync(join(host.dir, 'fstab'), 'utf8'), 'UUID=1234-abcd ' + host.home + ' ext4 defaults 0 2\n')
  } finally {
    host.cleanup()
  }
})
for (const [label, options, message] of [
  ['local state', { oldState: true }, 'contains local state'],
  ['root device', { root: true }, 'root disk'],
  ['unknown filesystem', { filesystem: 'xfs' }, 'not ext4'],
  ['disk signatures', { signatures: 'gpt' }, 'existing signatures'],
] as const)
  test('EBS boot refuses ' + label + ' before formatting or mounting', () => {
    const host = fixture(options)
    try {
      const result = host.run()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, new RegExp(message))
      assert.equal(host.log(), '')
    } finally {
      host.cleanup()
    }
  })
test('EBS boot refuses a missing attachment after its bounded wait', () => {
  const host = fixture({ missing: true })
  try {
    const result = host.run()
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /did not attach/)
    assert.equal(host.log().trim().split('\n').length, 120)
  } finally {
    host.cleanup()
  }
})
test('EBS setup rejects values that could escape its shell arguments', () => {
  assert.throws(() => awsDataDiskSetup({ volumeId: 'vol-id;false' }), /requires/)
  assert.throws(() => awsDataDiskSetup({ volumeId, home: '/var/lib/../root' }), /requires/)
})

test('EBS boot refuses symlink homes and device-link collisions before touching data', () => {
  for (const collision of ['home', 'device-link']) {
    const host = fixture()
    try {
      if (collision === 'home') {
        rmSync(host.home, { recursive: true })
        const target = join(host.dir, 'outside')
        mkdirSync(target)
        symlinkSync(target, host.home)
      } else writeFileSync(join(host.dir, 'data-link'), 'preserve this path')
      const result = host.run()
      assert.notEqual(result.status, 0)
      assert.match(result.stderr, /symlink|replace another path/)
      assert.equal(host.log(), '')
    } finally {
      host.cleanup()
    }
  }
})
test('EBS boot refuses an already-mounted foreign device and conflicting fstab', () => {
  const host = fixture({ filesystem: 'ext4' })
  try {
    writeFileSync(join(host.dir, 'mounted'), join(host.dir, 'dev/nvme0n1'))
    const mounted = host.run()
    assert.notEqual(mounted.status, 0)
    assert.match(mounted.stderr, /mounted from another device/)
    assert.equal(host.log(), '')
    rmSync(join(host.dir, 'mounted'))
    writeFileSync(join(host.dir, 'fstab'), 'UUID=another ' + host.home + ' ext4 defaults 0 2\n')
    const configured = host.run()
    assert.notEqual(configured.status, 0)
    assert.match(configured.stderr, /another filesystem in fstab/)
    assert.equal(host.log(), '')
  } finally {
    host.cleanup()
  }
})
