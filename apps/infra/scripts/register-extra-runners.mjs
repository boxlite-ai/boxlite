// The engine stores this exact path in the RegisterExtraRunners command
// resource, so keep the launcher stable while the implementation moves.
//
// A sibling of scripts/register-runners.mjs rather than a change to it: that
// one launches the legacy SST stack's copy (apps/infra/runner/register.ts) and
// is recorded in that stack's state. Two launchers is the cost of replacing a
// deploy path without breaking the one still deployed.
import 'tsx/esm'

await import('../mdeploy/src/register-runners.ts')
