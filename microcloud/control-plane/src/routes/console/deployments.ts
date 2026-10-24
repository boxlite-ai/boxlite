/** Console API: roll back to a release, one deployment as a timeline, and its source download. */
import type { Hono } from 'hono';
import { deploymentChanges, failureView, type Timeline } from '../../console-deployment.js';
import { releaseId, releaseViews } from '../../console-releases.js';
import { fail } from '../../errors.js';
import { logLevel } from '../../services/logs.js';
import type { ConsoleKit } from './kit.js';

export function consoleDeploymentRoutes(api: Hono, k: ConsoleKit): void {
  const { ctx, cp, raw, appOf, envOf, v1, detail } = k;
  const { store } = ctx;

  /** Rollback = a new deployment of kind rollback, run by the orchestrator like any other. */
  api.post('/apps/:id/releases/:rid/activate', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const to = Number(decodeURIComponent(c.req.param('rid')).replace(/^#/, ''));
    if (!Number.isInteger(to) || to < 1) throw fail('invalid_request', 'release ids look like #7');
    await cp('POST', `${v1(app, env)}/deployments`, { kind: 'rollback', to, message: `Roll back to ${releaseId(to)}` });
    return c.json(await detail(app, env));
  });

  /** One deployment as a timeline: steps with start and duration, every log line, what changed, the classified failure. */
  api.get('/apps/:id/deployments/:n', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const n = Number(c.req.param('n'));
    const d = Number.isInteger(n) ? store.deployment(env.id, n) : undefined;
    if (!d) throw fail('not_found', `no deployment #${c.req.param('n')} in ${env.name}`, 'pick one from the Deployments list');
    const timeline = await cp<Timeline>('GET', `${v1(app, env)}/deployments/${n}/timeline`);
    const release = releaseViews(ctx, app, env, 200).find((r) => r.number === n)!;
    const failure = failureView(ctx, app, env, d);
    return c.json({
      ...release,
      message: d.message,
      specVersion: d.spec_version,
      baseVersion: d.base_version,
      snapshotId: d.snapshot_id,
      rollbackTo: d.kind === 'rollback' ? (d.request.to ?? null) : null,
      timeline: timeline.steps.map((s) => ({ name: s.name, status: s.status, ms: s.ms ?? null, detail: s.detail ?? null, startedAt: s.started_at, finishedAt: s.finished_at })),
      log: timeline.logs.map((l) => ({ id: `l${l.id}`, ts: l.ts, source: l.source, level: logLevel(l.level), line: l.line })),
      logTruncated: timeline.truncated,
      changeSet: deploymentChanges(ctx, app, env, d),
      failure: failure ? { step: failure.step, message: failure.message, ...failure.diagnosis, fixPrompt: failure.fixPrompt } : null,
    });
  });

  api.get('/apps/:id/deployments/:n/source', async (c) => {
    const app = appOf(c);
    const env = envOf(c, app);
    const res = await raw('GET', `${v1(app, env)}/deployments/${encodeURIComponent(c.req.param('n'))}/source`);
    return new Response(res.body, { status: res.status, headers: res.headers });
  });
}
