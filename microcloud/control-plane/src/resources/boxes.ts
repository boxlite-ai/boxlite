/** An env's Box: create or replace it (image, size, volumes), its tunnel, waiting for its supervisor, and self-healing a Box that never boots. */
import type { VolumeSpec } from '@microcloud/shared';
import { newBoxToken, sha256hex } from '../auth.js';
import type { AppRow, EnvRow } from '../db.js';
import { now } from '../db.js';
import type { Ctx } from '../ctx.js';
import { UpstreamError, fail } from '../errors.js';
import { retry, sleep } from '../http.js';
import { BOX_AUTO_STOP_S, BOX_CMD, BOX_DISK_GB, BOX_SIZES, GATEWAY_PORT, IMAGE_REFS, SUPERVISOR_PROTOCOL } from '../platform.js';
import { volumeKey, volumeMounts } from './volumes.js';
import type { BoxWaker } from './wake.js';

export type Logger = (line: string) => void;

const SUPERVISOR_TIMEOUT = 'supervisor_timeout';
const isSupervisorTimeout = (err: unknown) => (err as { details?: { reason?: string } })?.details?.reason === SUPERVISOR_TIMEOUT;

export class BoxProvisioner {
  constructor(
    private readonly ctx: Omit<Ctx, 'resources' | 'orchestrator' | 'scheduler'>,
    private readonly waker: BoxWaker,
  ) {}

  /**
   * Makes sure the env has a running Box with a registered tunnel and an answering supervisor.
   * A change of image, size or volume set cannot be applied to an existing Box, so the old Box is
   * stopped and a new one is created (its releases do not carry over; rollback stays per Box).
   */
  async ensureBox(app: AppRow, envId: string, want: { image: string; size: string; volumes: VolumeSpec[] }, deployment: number, log: Logger): Promise<EnvRow> {
    try {
      return await this.ensureBoxOnce(app, envId, want, deployment, log, false);
    } catch (err) {
      const env = this.ctx.store.envById(envId)!;
      // Self-heal a Box that never came up. BoxLite occasionally hands out a Box without working
      // outbound network (measured 2026-10-22: no DNS, no route), so its boot cannot download the
      // supervisor and it never answers. A Box that never served a release holds nothing worth
      // keeping, so replace it once instead of letting the agent retry the same dead Box.
      if (!isSupervisorTimeout(err) || env.live_deployment || !env.box_id) throw err;
      log(`Box ${env.box_id} never started its supervisor (it usually means the Box has no outbound network); replacing it with a new Box`);
      await this.ctx.boxlite.deleteBox(env.box_id).catch((e) => log(`deleting Box ${env.box_id} failed (ignored): ${(e as Error).message}`));
      this.ctx.store.updateEnv(env.id, { box_id: null, box_url: null, services: null });
      return this.ensureBoxOnce(app, envId, want, deployment, log, true);
    }
  }

  private async ensureBoxOnce(app: AppRow, envId: string, want: { image: string; size: string; volumes: VolumeSpec[] }, deployment: number, log: Logger, retrying: boolean): Promise<EnvRow> {
    const { store, boxlite } = this.ctx;
    let env = store.envById(envId)!;
    const volumes = volumeKey(want.volumes);
    let box = env.box_id ? await boxlite.getBox(env.box_id) : null;
    let replacing = false;
    if (env.box_id && !box) {
      log(`Box ${env.box_id} no longer exists; creating a new one`);
      replacing = true;
    } else if (box && (env.box_image !== want.image || env.box_size !== want.size || (env.box_volumes ?? '') !== volumes)) {
      log(`runtime changed (image ${env.box_image}→${want.image}, size ${env.box_size}→${want.size}, volumes [${env.box_volumes ?? ''}]→[${volumes}]); replacing Box ${box.id}`);
      if (env.box_volumes || volumes) {
        // A managed volume can only be mounted by one Box, so the old Box has to go entirely.
        await boxlite.deleteBox(box.id);
      } else {
        await boxlite.stopBox(box.id).catch((err) => log(`stopping old Box failed (ignored): ${(err as Error).message}`));
      }
      box = null;
      replacing = true;
    }

    if (!box) {
      const size = BOX_SIZES[want.size]!;
      const token = newBoxToken();
      store.tx(() => {
        store.run('UPDATE box_tokens SET revoked_at = ? WHERE env_id = ? AND revoked_at IS NULL', now(), env.id);
        store.run('INSERT INTO box_tokens (hash, env_id, created_at) VALUES (?, ?, ?)', sha256hex(token), env.id, now());
      });
      const mounts = want.volumes.length ? await volumeMounts(this.ctx, app, env, want.volumes, log) : [];
      // A replaced Box may still exist (stopped), so the new one needs a distinct name.
      const name = retrying ? `app-${app.name}-${env.name}-${deployment}-r` : replacing ? `app-${app.name}-${env.name}-${deployment}` : `app-${app.name}-${env.name}`;
      log(`creating Box ${name} (${want.image}, ${size.cpus} CPU / ${size.memory_mib} MiB)`);
      box = await boxlite.createBox({
        name,
        image: IMAGE_REFS[want.image]!,
        cpus: size.cpus,
        memory_mib: size.memory_mib,
        disk_size_gb: BOX_DISK_GB,
        // Identity headers are honoured only on requests carrying the forwarding secret, which only
        // the CP holds (app code runs as another uid and cannot read it; contracts §2.1, F2/F3).
        env: { BOXLITE_CP_URL: this.ctx.config.publicUrl, BOXLITE_BOX_TOKEN: token, BOXLITE_ENV_ID: env.id, SV_TRUST_USER_HEADERS: '1' },
        cmd: BOX_CMD,
        auto_stop: BOX_AUTO_STOP_S,
        auto_resume: true,
        network: { inbound: { mode: 'enabled' } },
        ...(mounts.length ? { volumes: mounts } : {}),
      });
      store.updateEnv(env.id, { box_id: box.id, box_url: null, box_image: want.image, box_size: want.size, box_volumes: volumes, services: null });
      env = store.envById(envId)!;
    } else if (box.status === 'stopped') {
      log(`starting Box ${box.id}`);
      await boxlite.startBox(box.id);
      this.waker.noteWake(box.id);
    }

    if (!env.box_url) {
      const uri = await retry(() => boxlite.tunnel(env.box_id!, GATEWAY_PORT), { attempts: 5, delayMs: 3_000, retryable: (err) => err instanceof UpstreamError });
      log(`tunnel ${uri}`);
      store.updateEnv(env.id, { box_url: uri });
      env = store.envById(envId)!;
    }
    await this.waitForSupervisor(env, log);
    return store.envById(envId)!;
  }

  /**
   * Waits until the env's supervisor answers health with the control secret. 403 (no secrets until
   * the supervisor's first /sv/v1/spec) and connection errors mean "not ready yet".
   *
   * Every Box runs wire protocol 2 since the 2026-10-21 rollout, and a Box downloads the current
   * supervisor on every start, so the CP no longer restarts old ones. A supervisor that still
   * reports an older protocol means the CP serves an old build: that is refused, not worked around.
   */
  async waitForSupervisor(env: EnvRow, log: Logger): Promise<void> {
    const { supervisor, timing } = this.ctx;
    const deadline = Date.now() + timing.supervisorReadyMs;
    let lastErr = '';
    log('waiting for the supervisor to answer');
    while (Date.now() < deadline) {
      let version: number | undefined;
      try {
        // Any 200 counts: `ok` only turns true once a release is live, which a fresh Box has not.
        // An answer to the control secret without `version` is protocol 2 (protocol 1 refuses it).
        version = (await supervisor.health(env.box_url!, env.control_secret)).version ?? SUPERVISOR_PROTOCOL;
      } catch (err) {
        lastErr = (err as Error).message;
      }
      if (version !== undefined) {
        if (version >= SUPERVISOR_PROTOCOL) return;
        throw fail('deploy_failed', `Box ${env.box_id} runs supervisor protocol ${version}; this control plane needs ${SUPERVISOR_PROTOCOL}`, 'check that SV_BIN_DIR on the control plane holds the current supervisor build, then deploy again');
      }
      await sleep(timing.pollMs);
    }
    throw fail('deploy_failed', `the supervisor in Box ${env.box_id} did not answer within ${Math.round(timing.supervisorReadyMs / 1000)} s (${lastErr})`, 'read the Box boot with `boxlite-app app logs --source system --since 30m`, then `boxlite-app deploy` again', { reason: SUPERVISOR_TIMEOUT });
  }

  /** For apply/rollback: the existing Box must be up (no recreation), started if it auto-stopped. */
  async ensureRunning(envId: string, log: Logger): Promise<EnvRow> {
    const { store, boxlite } = this.ctx;
    const env = store.envById(envId)!;
    if (!env.box_id || !env.box_url) throw fail('deploy_failed', 'this environment has no Box yet', 'run `boxlite-app deploy` first');
    const box = await boxlite.getBox(env.box_id);
    if (!box) throw fail('deploy_failed', `Box ${env.box_id} no longer exists`, 'run `boxlite-app deploy` to create a new one');
    if (box.status === 'stopped') {
      log(`starting Box ${box.id}`);
      await boxlite.startBox(box.id);
      this.waker.noteWake(box.id);
    }
    await this.waitForSupervisor(env, log);
    return env;
  }
}
