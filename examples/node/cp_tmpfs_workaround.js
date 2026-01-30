/**
 * Workaround: copy files into tmpfs destinations (e.g. /tmp) inside a container.
 *
 * copy_in() writes to the rootfs layer, so files destined for tmpfs mounts
 * are invisible to the running container. This is the same limitation as
 * `docker cp` (see https://github.com/moby/moby/issues/22020).
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

    // --- The problem: copy_in to /tmp silently fails ---
    const hostFile = join(tmpdir(), `boxlite-test-${Date.now()}.txt`);
    writeFileSync(hostFile, "you won't see me\n");

    try {
      await box._box.copyIn(hostFile, '/tmp/ghost.txt');
      const result = await box.exec('ls', '/tmp/ghost.txt');
      console.log(
        `copy_in to /tmp:     exit=${result.exitCode}  ` +
        `${result.exitCode === 0 ? 'FOUND' : 'NOT FOUND (expected)'}`
      );
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
