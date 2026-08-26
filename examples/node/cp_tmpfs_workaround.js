/**
 * Workaround: copy files into tmpfs destinations (e.g. /tmp) inside a container.
 *
 * copy_in() writes to the rootfs layer, from outside the container's mount
 * namespace, so a destination under a mount (/tmp, /dev/shm, volumes) would
 * land where no process in the box can see it. Rather than lose the file
 * silently — which is what `docker cp` does, see
 * https://github.com/moby/moby/issues/22020 — BoxLite refuses the copy and
 * names the mount.
 *
 * The fix is the same as Docker's recommendation: pipe a tar archive through
 * a command running inside the container's mount namespace, which sees tmpfs.
 */

import { SimpleBox } from '@boxlite-ai/boxlite';
import { writeFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Create a minimal tar archive from a map of {filename: content}.
 *
 * Tar format: for each file, a 512-byte header + data padded to 512 bytes,
 * followed by two 512-byte zero blocks as end-of-archive marker.
 */
function makeTar(files) {
  const blocks = [];

  for (const [name, content] of Object.entries(files)) {
    const data = typeof content === 'string' ? Buffer.from(content) : content;

    // Build 512-byte tar header
    const header = Buffer.alloc(512);
    // Name (0-99)
    header.write(name, 0, Math.min(name.length, 100), 'utf8');
    // Mode (100-107) - 0644
    header.write('0000644\0', 100, 8, 'utf8');
    // UID (108-115)
    header.write('0000000\0', 108, 8, 'utf8');
    // GID (116-123)
    header.write('0000000\0', 116, 8, 'utf8');
    // Size (124-135) - octal
    header.write(data.length.toString(8).padStart(11, '0') + '\0', 124, 12, 'utf8');
    // Mtime (136-147)
    header.write('00000000000\0', 136, 12, 'utf8');
    // Typeflag (156) - '0' = regular file
    header.write('0', 156, 1, 'utf8');

    // Checksum (148-155) - compute over header with checksum field as spaces
    // First fill checksum field with spaces
    header.write('        ', 148, 8, 'utf8');
    let checksum = 0;
    for (let i = 0; i < 512; i++) {
      checksum += header[i];
    }
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'utf8');

    blocks.push(header);

    // Data blocks (padded to 512 bytes)
    const paddedSize = Math.ceil(data.length / 512) * 512;
    const dataBlock = Buffer.alloc(paddedSize);
    data.copy(dataBlock);
    blocks.push(dataBlock);
  }

  // End-of-archive: two 512-byte zero blocks
  blocks.push(Buffer.alloc(1024));

  return Buffer.concat(blocks);
}

async function main() {
  const box = new SimpleBox({ image: 'alpine:latest', name: 'node-tmpfs-cp-demo' });

  try {
    // Ensure box is created
    await box.getId();

    // --- The problem: /tmp is a tmpfs, so copy_in cannot reach it ---
    const hostFile = join(tmpdir(), `boxlite-test-${Date.now()}.txt`);
    writeFileSync(hostFile, "you won't see me\n");

    try {
      await box._box.copyIn(hostFile, '/tmp/ghost.txt');
      console.log('copy_in to /tmp:     unexpectedly succeeded');
    } catch (err) {
      console.log(`copy_in to /tmp:     refused (expected)\n  ${err.message}`);
    } finally {
      unlinkSync(hostFile);
    }

    // --- The workaround: pipe tar through container process ---
    const tarData = makeTar({ 'hello.txt': 'visible!\n' });

    // Use low-level API to get stdin access (like: docker exec -i ... tar xf -)
    const tarExec = await box._box.exec('tar', ['xf', '-', '-C', '/tmp']);
    const stdin = await tarExec.stdin();
    await stdin.write(tarData);
    await stdin.close();
    const tarResult = await tarExec.wait();
    console.log(`tar via stdin:       exit=${tarResult.exitCode}`);

    const catResult = await box.exec('cat', '/tmp/hello.txt');
    console.log(`read /tmp/hello.txt: ${catResult.stdout.trim()}`);
  } finally {
    await box.stop();
  }
}

main().catch(error => {
  console.error('Error:', error);
  process.exit(1);
});
