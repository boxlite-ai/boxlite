// Deletes throwaway smoke-test projects (name prefix mc-) by id, or lists them. Run:
//   npx tsx scripts/neon-cleanup.ts [project-id…]
import { loadDotEnvLocal } from '../src/config.js';
import { HttpNeonClient } from '../src/neon.js';

loadDotEnvLocal();
const key = process.env.NEON_API_KEY ?? '';
const neon = new HttpNeonClient(key, process.env.NEON_ORG_ID ?? '');
for (const id of process.argv.slice(2)) {
  await neon.deleteProject(id);
  const r = await fetch(`https://console.neon.tech/api/v2/projects/${id}`, { headers: { authorization: `Bearer ${key}` } });
  console.log(`deleted ${id}: GET → ${r.status}`);
}
const l = await fetch(`https://console.neon.tech/api/v2/projects?org_id=${process.env.NEON_ORG_ID}&search=mc-`, { headers: { authorization: `Bearer ${key}` } });
const j = (await l.json()) as { projects?: { id: string; name: string }[] };
console.log(`remaining mc- projects: ${JSON.stringify((j.projects ?? []).map((p) => [p.id, p.name]))}`);
