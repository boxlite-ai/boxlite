import type { Command } from 'commander';
import type { MakeCtx } from '../cli.js';
import type { Ctx } from '../context.js';
import { describe } from '../meta.js';
import { formatAgo, table } from '../output.js';

async function scheduleList(ctx: Ctx): Promise<void> {
  const list = await (await ctx.appApi()).listSchedules();
  ctx.out.data(list);
  if (!list.length) {
    ctx.out.line('no schedules in the live spec');
    ctx.out.next('add a [[schedule]] to boxlite.toml (name, cron, target = "web:/path"), then `boxlite-app deploy`');
    return;
  }
  const rows = list.map((s) => [s.name, s.cron, s.target, s.next_run ? `next ${s.next_run}` : 'next —', s.last_run ? `last ${formatAgo(s.last_run)} → ${s.last_status ?? '?'}` : 'never ran']);
  for (const line of table(rows)) ctx.out.line(line);
  const failing = list.find((s) => (s.last_status ?? 0) >= 400);
  if (failing) ctx.out.next(`\`boxlite-app app logs --source schedule --grep ${failing.name}\`, then \`boxlite-app app schedule run ${failing.name}\``);
}

async function scheduleRun(ctx: Ctx, name: string): Promise<void> {
  const result = (await (await ctx.appApi()).runSchedule(name)) as { name: string; status: number; ms: number; starting: boolean };
  ctx.out.data(result);
  if (result.starting) {
    ctx.out.line(`schedule ${name}: the app is waking up; the run happens on the next tick (≤30 s)`);
    ctx.out.next(`\`boxlite-app app logs --source schedule --since 2m\``);
    return;
  }
  ctx.out.line(`schedule ${name} → HTTP ${result.status} in ${result.ms} ms`);
  if (result.status >= 400) ctx.out.next(`the target answered ${result.status}; \`boxlite-app app logs --since 5m --level error\``);
}

export function registerSchedule(app: Command, make: MakeCtx): void {
  const schedule = app.command('schedule').description('scheduled jobs ([[schedule]] in boxlite.toml)');
  describe(schedule.command('list').description('schedules with next run and last result').action(async (_o: unknown, cmd: Command) => scheduleList(await make(cmd))), {
    json: '{ name, cron, target, next_run: string | null, last_run: string | null, last_status: number | null }[]',
    exits: [2, 3],
    online: true,
  });
  describe(
    schedule
      .command('run <name>')
      .description('trigger a schedule now (POST to its target, like the scheduler does)')
      .action(async (name: string, _o: unknown, cmd: Command) => scheduleRun(await make(cmd), name)),
    { json: '{ name: string, status: number, ms: number, starting: boolean }', exits: [2, 3, 4], online: true },
  );
}
