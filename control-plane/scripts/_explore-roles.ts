import pg from 'pg';
import { loadDotEnvLocal } from '../src/config.js';
import { HttpNeonClient } from '../src/neon.js';
loadDotEnvLocal();
const key = process.env.NEON_API_KEY!;
const neon = new HttpNeonClient(key, process.env.NEON_ORG_ID ?? '');
const api = async (method: string, path: string, body?: unknown) => {
  for (let i = 0; i < 20; i++) {
    const r = await fetch(`https://console.neon.tech/api/v2${path}`, { method, headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', accept: 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    const t = await r.text();
    if (r.status === 423) { await new Promise((x) => setTimeout(x, 1500)); continue; }
    return { status: r.status, body: t };
  }
  return { status: 0, body: 'locked' };
};
const p = await neon.createProject(`mc-explore-${Date.now().toString(36)}`);
const P = p.projectId, MAIN = p.mainBranchId;
console.log('project', P);
const bail = async (e: unknown) => { console.log('CRASH', (e as Error).message); await neon.deleteProject(P); console.log('deleted'); process.exit(1); };
process.on('uncaughtException', bail); process.on('unhandledRejection', bail);
const sql = async (uri: string, q: string) => {
  const u = new URL(uri); u.searchParams.delete('sslmode'); u.searchParams.delete('channel_binding');
  const c = new pg.Client({ connectionString: u.toString(), ssl: { rejectUnauthorized: true } }); c.on('error', () => {});
  try { await c.connect(); const r = await c.query(q); return `OK ${JSON.stringify(r.rows).slice(0, 200)}`; } catch (e) { return `ERR ${(e as any).code} ${(e as Error).message}`; } finally { await c.end().catch(() => {}); }
};
const readerUri = (uri: string, pw: string) => { const u = new URL(uri); u.username = 'boxlite_reader'; u.password = pw; return u.toString(); };
try {
  const owner = p.connectionUri;
  console.log('API POST role:', (await api('POST', `/projects/${P}/branches/${MAIN}/roles`, { role: { name: 'boxlite_reader' } })).status);
  const pw = JSON.parse((await api('GET', `/projects/${P}/branches/${MAIN}/roles/boxlite_reader/reveal_password`)).body).password;
  console.log('  grant:', await sql(owner, 'GRANT pg_read_all_data TO boxlite_reader'));
  await sql(owner, 'CREATE TABLE t (id int); INSERT INTO t VALUES (1)');
  const R = readerUri(owner, pw);
  console.log('  owner revoke neon_superuser:', await sql(owner, 'REVOKE neon_superuser FROM boxlite_reader'));
  console.log('  owner alter nocreaterole:', await sql(owner, 'ALTER ROLE boxlite_reader NOCREATEROLE NOCREATEDB'));
  console.log('  owner alter set ro:', await sql(owner, 'ALTER ROLE boxlite_reader SET default_transaction_read_only = on'));
  console.log('  reader revoke itself:', await sql(R, 'REVOKE neon_superuser FROM boxlite_reader'));
  console.log('  reader alter itself:', await sql(R, 'ALTER ROLE boxlite_reader SET default_transaction_read_only = on'));
  console.log('  membership opts:', await sql(owner, "select r.rolname, m.admin_option, m.inherit_option, m.set_option, g.rolname as grantor from pg_auth_members m join pg_roles r on r.oid=m.roleid join pg_roles g on g.oid = m.grantor where m.member=(select oid from pg_roles where rolname='boxlite_reader')"));
  console.log('  reader default ro now:', await sql(R, "select current_setting('default_transaction_read_only'), current_setting('transaction_read_only')"));
  console.log('  reader set role neon_superuser:', await sql(R, 'SET ROLE neon_superuser'));
  console.log('  reader terminate owner in RO tx:', await sql(R, "BEGIN READ ONLY"));
  {
    const b = await api('POST', `/projects/${P}/branches`, { branch: { name: 'so', parent_id: MAIN, init_source: 'schema-only' }, endpoints: [{ type: 'read_write' }] });
    const bid = JSON.parse(b.body).branch.id;
    console.log('schema-only', b.status, bid);
    const cu = await api('GET', `/projects/${P}/connection_uri?branch_id=${bid}&database_name=neondb&role_name=neondb_owner`);
    const ownerB = JSON.parse(cu.body).uri;
    for (let i = 0; i < 3; i++) {
      await new Promise((x) => setTimeout(x, 4000));
      const st = JSON.parse((await api('GET', `/projects/${P}/branches/${bid}`)).body).branch.current_state;
      console.log(`  t+${(i + 1) * 4}s state ${st}; roles:`, JSON.parse((await api('GET', `/projects/${P}/branches/${bid}/roles`)).body).roles.map((r: any) => r.name).join(','), 'reveal:', (await api('GET', `/projects/${P}/branches/${bid}/roles/boxlite_reader/reveal_password`)).status);
    }
    console.log('  pg_roles on branch:', await sql(ownerB, "select rolname, rolcanlogin from pg_roles where rolname='boxlite_reader'"));
    console.log('  tables on branch:', await sql(ownerB, "select count(*) from t"));
    console.log('  login with main pw:', await sql(readerUri(ownerB, pw), 'select current_user'));
    console.log('  POST role:', (await api('POST', `/projects/${P}/branches/${bid}/roles`, { role: { name: 'boxlite_reader' } })).body.slice(0, 150));
    console.log('  DELETE role:', (await api('DELETE', `/projects/${P}/branches/${bid}/roles/boxlite_reader`)).body.slice(0, 150));
    const post = await api('POST', `/projects/${P}/branches/${bid}/roles`, { role: { name: 'boxlite_reader' } });
    console.log('  POST after delete:', post.status, post.body.slice(0, 120).replace(/"password":"[^"]+"/, ''));
    const r2 = await api('GET', `/projects/${P}/branches/${bid}/roles/boxlite_reader/reveal_password`);
    console.log('  reveal:', r2.status);
    if (r2.status === 200) {
      const pw2 = JSON.parse(r2.body).password;
      console.log('  grant on branch:', await sql(ownerB, 'GRANT pg_read_all_data TO boxlite_reader'));
      console.log('  read on branch:', await sql(readerUri(ownerB, pw2), 'select current_user, count(*) from t'));
    }
    console.log('  reset password endpoint:', (await api('POST', `/projects/${P}/branches/${MAIN}/roles/boxlite_reader/reset_password`)).status);
  }
  console.log('5 DELETE role via API on main:', (await api('DELETE', `/projects/${P}/branches/${MAIN}/roles/boxlite_reader`)).status);
} finally { await neon.deleteProject(P); console.log('deleted', P, (await api('GET', `/projects/${P}`)).status); }
