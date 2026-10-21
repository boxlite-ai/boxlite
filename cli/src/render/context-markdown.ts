import type { AgentContext } from '@microcloud/shared';

const cell = (v: unknown): string => (v === null || v === undefined || v === '' ? '—' : String(v).replace(/\|/g, '\\|').replace(/\n/g, ' '));

function tableMd(head: string[], rows: unknown[][]): string[] {
  return [`| ${head.join(' | ')} |`, `|${head.map(() => '---').join('|')}|`, ...rows.map((r) => `| ${r.map(cell).join(' | ')} |`)];
}

/** `app context --format markdown`: one document an agent can read top to bottom before working. */
export function contextMarkdown(c: AgentContext): string {
  const out: string[] = [`# ${c.app} · ${c.env}`, ''];
  out.push(`- Status: **${c.status}**${c.live ? ` (live: #${c.live.deployment}, spec v${c.live.spec_version ?? '?'})` : ''}`);
  out.push(`- URL: ${c.urls.app}`);
  if (c.urls.health) out.push(`- Health: ${c.urls.health}`);
  out.push(`- Access: ${c.access.level}${c.access.source === 'online' ? ' (set online; overrides boxlite.toml)' : ''}`);
  if (c.box) out.push(`- Box: ${c.box.state}${c.box.state === 'stopped' ? ' (asleep; the next request wakes it)' : ''}`);
  if (c.runtime) out.push(`- Runtime: ${c.runtime.image}/${c.runtime.size}; build: ${c.runtime.build.length ? `\`${c.runtime.build.join(' && ')}\`` : 'none'}`);
  out.push(`- Control plane: ${c.control_plane}`);
  if (c.environments.length > 1) out.push(`- Environments: ${c.environments.map((e) => `${e.name} (${e.status})`).join(', ')}`);
  out.push('');

  out.push('## Next actions', '');
  if (!c.next_actions.length) out.push('Nothing needs attention.');
  for (const f of c.next_actions) {
    out.push(`- **${f.severity}** ${f.title}${f.detail ? ` (${f.detail})` : ''}`, `  - fix: ${f.fix}`);
    for (const e of f.evidence ?? []) out.push(`  - \`${e.slice(0, 200)}\``);
  }
  out.push('');

  out.push('## Services', '');
  if (!c.services.length) out.push('No services declared yet.');
  else out.push(...tableMd(['service', 'exposed', 'runs', 'health path', 'state', 'health', 'restarts', 'last exit'], c.services.map((s) => [s.name, s.exposed ? 'yes' : '', s.command ?? (s.static ? `static ${s.static}` : ''), s.health_path, s.state, s.health, s.restarts, s.last_exit_code])));
  out.push('');

  if (c.schedules.length) {
    out.push('## Schedules', '', ...tableMd(['name', 'cron (UTC)', 'target', 'next run', 'last run', 'last status'], c.schedules.map((s) => [s.name, `\`${s.cron}\``, s.target, s.next_run, s.last_run, s.last_status])), '');
  }

  out.push('## Database', '');
  if (!c.database) out.push('None. Add `[database]` to boxlite.toml and run `boxlite-app apply --yes`.');
  else {
    out.push(`- Status: ${c.database.status}${c.database.branch ? ` (branch ${c.database.branch})` : ''}${c.database.error ? ` — ${c.database.error}` : ''}`);
    if (c.database.migrations.length) out.push('', ...tableMd(['migration', 'status', 'deployment', 'applied at'], c.database.migrations.map((m) => [m.file, m.status, m.deployment, m.applied_at])));
    for (const t of c.database.tables) {
      out.push('', `### ${t.name}`, '', ...tableMd(['column', 'type', 'null', 'default'], t.columns.map((col) => [col.name, col.type, col.nullable ? 'yes' : 'no', col.default])));
    }
    if (c.database.status === 'ready' && !c.database.tables.length) out.push('- No tables yet.');
  }
  out.push('');

  out.push('## Volumes', '');
  if (!c.volumes.length) out.push('None.');
  for (const v of c.volumes) out.push(`- ${v.name} at \`${v.mount}\` (${v.mode}); list it with \`boxlite-app app volume ls ${v.name}\``);
  out.push('');

  out.push('## Sign-in', '');
  if (!c.auth.enabled) out.push('Off (no `[auth]` in boxlite.toml).');
  else {
    out.push(`- Providers: ${c.auth.providers.map((p) => `${p.name} (${p.status === 'ready' ? 'ready' : 'not configured on this platform'})`).join(', ')}`);
    out.push(`- Protected paths: ${c.auth.protect.length ? c.auth.protect.map((p) => `\`${p}\``).join(', ') : 'none'}`);
    out.push(`- Login: ${c.auth.login_url} · users: ${c.auth.users}`);
  }
  out.push('');

  out.push('## Variables', '');
  if (!c.variables.length) out.push('None.');
  else out.push(...tableMd(['name', 'value', 'source'], c.variables.map((v) => [v.name, v.secret ? (v.resolved ? '(secret, set)' : '(secret, MISSING)') : v.value, v.source])));
  out.push('');

  out.push('## Recent deployments', '');
  if (!c.deployments.length) out.push('None yet.');
  else {
    out.push(...tableMd(['#', 'kind', 'status', 'message', 'created'], c.deployments.map((d) => [d.number, d.kind, d.status, d.message, d.created_at])));
    for (const d of c.deployments.filter((x) => x.error)) out.push('', `- #${d.number} failed at ${d.error!.step}: ${d.error!.message}`);
  }
  out.push('');

  out.push('## Recent errors (24 h)', '');
  if (!c.recent_errors.length) out.push('None.');
  else out.push('```', ...c.recent_errors.map((e) => `${e.ts} [${e.source}] ${e.line}`), '```');
  out.push('');

  out.push('## Reminders', '');
  out.push('- The app owns its origin (`BOXLITE_APP_URL`); never hardcode that URL. Check pages with `boxlite-app app curl <path>` (`--as <email>` for signed-in pages).');
  out.push('- Listen on `process.env.PORT` and `0.0.0.0`.');
  out.push('- Schema changes only via a new `migrations/NNNN_name.sql` (`boxlite-app app db migration new <name>`); applied files are immutable.');
  out.push('- Full guide offline: `boxlite-app docs`.');
  out.push('');
  return out.join('\n');
}
