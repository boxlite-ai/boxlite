// Live check of the BoxLite calls the CP makes (creates and deletes a throwaway Box and volume).
// The Box's PID 1 cannot reach a CP from here, so this only checks the API surface.
// Run: npx tsx scripts/boxlite-smoke.ts   (needs BOXLITE_API_KEY)
import { HttpBoxliteClient } from '../src/boxlite.js';
import { loadDotEnvLocal } from '../src/config.js';
import { BOX_CMD, IMAGE_REFS } from '../src/platform.js';

loadDotEnvLocal();
const api = new HttpBoxliteClient((process.env.BOXLITE_API_URL ?? 'https://api.dev.boxlite.ai/v1').replace(/\/+$/, ''), process.env.BOXLITE_API_KEY ?? '');
const step = (s: string) => console.log(`- ${s}`);
const tag = Date.now().toString(36);
const volName = `mc-smoke-${tag}-data`;

const vol = await api.createVolume(volName);
step(`volume ${vol.id} ${vol.name}; listed: ${(await api.listVolumes()).some((v) => v.name === volName)}`);
let boxId: string | null = null;
try {
  const box = await api.createBox({
    name: `app-smoke-${tag}`,
    image: IMAGE_REFS.node!,
    cpus: 1,
    memory_mib: 1024,
    disk_size_gb: 10,
    env: { BOXLITE_CP_URL: 'https://cp.invalid', BOXLITE_BOX_TOKEN: 'bxt_smoke', BOXLITE_ENV_ID: 'env_smoke' },
    cmd: BOX_CMD,
    auto_stop: 900,
    auto_resume: true,
    network: { inbound: { mode: 'enabled' } },
    volumes: [{ managed_volume: volName, guest_path: '/data/smoke' }],
  });
  boxId = box.id;
  step(`box ${box.id} ${box.name} ${box.status}`);
  step(`get → ${(await api.getBox(box.id))?.status}`);
  step(`tunnel → ${await api.tunnel(box.id, 8080)}`);
  await api.stopBox(box.id);
  step(`stopped → ${(await api.getBox(box.id))?.status}`);
  step(`missing box → ${JSON.stringify(await api.getBox('doesnotexist00'))}`);
} finally {
  if (boxId) await api.deleteBox(boxId);
  step(`deleted box ${boxId}`);
  for (let i = 0; i < 10; i++) {
    try {
      await api.deleteVolume(vol.id);
      step(`deleted volume ${vol.id}`);
      break;
    } catch (err) {
      if (i === 9) throw err;
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
