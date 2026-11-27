/*
 * Registering the hosts the API does not seed itself.
 *
 * The API seeds exactly one runner row at boot, from `DEFAULT_RUNNER_NAME` and
 * `DEFAULT_RUNNER_API_KEY` (`apps/api/src/app.service.ts`). A fleet of one is
 * therefore complete the moment the API is up; every host beyond the first has
 * no row at all, and a host with no row gets 401 on every call it makes — it
 * polls, syncs and health-checks into a rejection forever, which is what a
 * `RUNNERS > 1` stage did until this existed.
 *
 * So the extra hosts are registered through the admin API after the deploy.
 * What lives here is the part that is the same on both clouds — which hosts
 * need a row, what the payload is, and where the script is — while each
 * provider constructs the command resource itself, because constructing
 * resources is a provider's job and `stack/index.ts` constructs none.
 *
 * Pairing is token-based: the row's `apiKey` must equal the host's
 * `BOXLITE_RUNNER_TOKEN`. That is the whole reason the token and the slot travel
 * together as a `RunnerAssignment` rather than as two lists.
 */

import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { RunnerAssignment } from './runners.ts'

/**
 * The launcher, and the directory it is relative to.
 *
 * A `.mjs` shim rather than the TypeScript directly: the command runs `node`,
 * and the path is recorded in the engine's state, so it has to stay stable
 * while the implementation moves.
 *
 * The directory is derived from this module's own location rather than read out
 * of `$cli.paths.root`, and that is not fussiness. A local command runs from
 * the engine's own cwd, so the directory has to be given — but `$cli` is a
 * name only SST defines: the Pulumi engine never injects it, so a GCP deploy
 * died on `$cli is not defined` before any of this ran. The two engines also
 * root that path differently, since their `sst.config.ts` files sit at
 * different depths. Computing it here is the one answer that is the same on
 * both, and it is checked rather than assumed.
 */
export const registrationDir = (): string =>
  // stack/ → mdeploy/ → apps/infra, which is where `scripts/` lives.
  dirname(dirname(dirname(fileURLToPath(import.meta.url))))

export const REGISTER_RUNNERS_COMMAND = 'node scripts/register-extra-runners.mjs'

/**
 * The hosts that need a row, which is every one after the first.
 *
 * Order is the fleet's, so the name a host was created under is the name it is
 * registered under. An empty result is the ordinary single-host case and means
 * no command should be created at all — see `stack.test.ts`.
 */
export const extraRunnersOf = (fleet: readonly RunnerAssignment[]): RunnerAssignment[] => fleet.slice(1)

/**
 * What the script is handed, as the one JSON value it parses.
 *
 * Built from resolved tokens rather than from the assignments directly: a token
 * is an `Input<string>`, and a payload that stringified one unresolved would
 * hand the API Pulumi's `[toString]` refusal text as a runner's key — the same
 * failure the runner boot script had, and just as silent, because the API would
 * accept it and no host would ever match it.
 */
export const registrationPayload = ({
  runners,
  tokens,
}: {
  runners: readonly RunnerAssignment[]
  /** The resolved tokens, in `runners` order. */
  tokens: readonly string[]
}): string => {
  if (runners.length !== tokens.length) {
    throw new Error(
      `the fleet has ${runners.length} host(s) to register and ${tokens.length} token(s) to register them ` +
        'with; pairing is token-based, so a mismatch would register a host under another host’s key',
    )
  }
  return JSON.stringify(
    runners.map((runner, index) => ({ name: runner.slot.controlPlaneRunnerName, apiKey: tokens[index] })),
  )
}
