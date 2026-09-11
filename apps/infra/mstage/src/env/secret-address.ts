/*
 * A secret a workload is handed by reference rather than by value.
 *
 * The store holds the address, never the secret: `{"address": "arn:…"}` for a
 * Parameter Store SecureString, `{"address": "projects/…/secrets/…"}` for a
 * Secret Manager secret. What resolves it is the platform the workload runs on —
 * an ECS `secrets` entry, a Cloud Run `secretKeyRef` — so the value never enters
 * a task definition, a revision that keeps its own copy forever, or the deploy
 * that arranged it.
 *
 * `env.selectGroup.secret` says which keys are addresses. A value's text
 * cannot: an ARN is a usable plaintext secret, and a plaintext secret starting
 * with `arn:` would be handed to a container as an address.
 *
 * `home` decides which format is accepted. Both AWS forms are, because both
 * resolve through that reference channel; which service holds a secret is not
 * the store's question.
 *
 * No message here quotes a value. The mistake this catches is a plaintext
 * secret written where an address belongs, and echoing it would put it in the
 * terminal the write was trying to keep it out of.
 */

import { EnvError } from './backend.ts'
import type { Cloud } from '../config/load.ts'

/**
 * The one group whose values are addresses, named here because this module
 * gives the name its meaning. `config/load.ts` reads it to refuse a key some
 * other group also names.
 */
export const SECRET_GROUP = 'secret'

/** The only field a stored address has. Anything else is a typo, not an option. */
const ADDRESS_FIELD = 'address'

type AddressForm = { pattern: RegExp; describe: string }

/**
 * What each cloud's reference channel can resolve.
 *
 * A full ARN, not a bare parameter name: ECS accepts a bare name only within
 * the task's own region and account, and an ARN shows both. The Secret Manager
 * form is the resource name without a version — Cloud Run takes the version as
 * its own field, so an address carrying one declares it twice.
 */
const ADDRESS_FORMS: Record<Cloud, AddressForm> = {
  aws: {
    pattern: /^arn:aws[a-z0-9-]*:(?:ssm:[a-z0-9-]+:\d{12}:parameter\/|secretsmanager:[a-z0-9-]+:\d{12}:secret:)\S+$/,
    describe:
      'a Parameter Store parameter ARN (arn:aws:ssm:<region>:<account>:parameter/<name>) ' +
      'or a Secrets Manager secret ARN',
  },
  gcp: {
    pattern: /^projects\/[a-z0-9-]+\/secrets\/[A-Za-z0-9_-]+$/,
    describe: 'a Secret Manager secret name (projects/<project>/secrets/<secret>), with no version on the end',
  },
}

/** The address one stored value holds, or an error naming the key and the form. */
const addressOf = ({ key, value, home }: { key: string; value: string; home: Cloud }): string => {
  // Every home has an entry: `config/load.ts` refuses any other value.
  const form = ADDRESS_FORMS[home]
  const expected = `a key in env.selectGroup.${SECRET_GROUP} holds {"${ADDRESS_FIELD}": …}, naming ${form.describe}`

  let parsed: unknown
  try {
    parsed = JSON.parse(value)
  } catch {
    // Without the parser's message: Node quotes the input, which is exactly
    // what must not be quoted for this key.
    throw new EnvError(`${key} does not hold JSON, and ${expected}`)
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new EnvError(`${key} does not hold a JSON object, and ${expected}`)
  }

  const extra = Object.keys(parsed).filter((field) => field !== ADDRESS_FIELD)
  if (extra.length > 0) {
    throw new EnvError(`${key} names ${extra.join(', ')}, which an address has no field for; ${expected}`)
  }

  const address = (parsed as Record<string, unknown>)[ADDRESS_FIELD]
  if (typeof address !== 'string' || address.trim() === '') {
    throw new EnvError(`${key} has no "${ADDRESS_FIELD}"; ${expected}`)
  }
  if (!form.pattern.test(address)) throw new EnvError(`${key} does not name ${form.describe}`)
  return address
}

/**
 * Refuses a value a key in the secret group cannot hold, before it is written.
 *
 * The mistake worth stopping is the secret itself written where its address
 * belongs: the store takes it, the deploy hands it over as an address, and
 * every task fails to start for a reason naming neither the key nor the write.
 */
export const assertSecretAddresses = ({
  entries,
  groups,
  home,
}: {
  entries: readonly [string, string][]
  groups: Record<string, string[]>
  home: Cloud
}): void => {
  const declared = groups[SECRET_GROUP]
  if (!declared) return
  for (const [key, value] of entries) if (declared.includes(key)) addressOf({ key, value, home })
}

/**
 * One group's values, read as the addresses they are.
 *
 * Handed the group already narrowed — `valuesOfGroup` is what says a group must
 * be complete, and this has no second opinion about it. What it adds is the one
 * thing only this module knows: that each of these values is an address, and
 * which shapes this cloud can resolve.
 */
export const secretAddressesOf = ({
  values,
  home,
}: {
  values: Record<string, string>
  home: Cloud
}): Record<string, string> =>
  Object.fromEntries(Object.entries(values).map(([key, value]) => [key, addressOf({ key, value, home })]))
