/*
 * How this repository names what it creates in a cloud.
 *
 * One file because two tools create names and neither may guess the other's:
 * `bootstrap/` creates the identities a deploy cannot create for itself, and
 * `mdeploy/stack/providers/` creates the rest during the deploy. A service
 * account bootstrap makes under one spelling and a deploy expects under another
 * fails as a permission error naming neither.
 *
 * Two forms, because two kinds of thing are named:
 *
 *   <appShort>-<stage>-<artifact>-<action>   an identity: who may do what
 *   <app>-<stage>-<artifact>                 an instance: the thing itself
 *
 * An identity takes the app abbreviated for one reason: a GCP service account
 * id is at most 30 characters, and the project these live in is shared with the
 * rest of BoxLite — so the name has to carry the app and still fit.
 * `boxlite-prod-otel-collector-run` is 31; `bl-app-prod-otel-collector-run` is
 * 30, the limit exactly. That one character of headroom is why the limit is
 * checked here: the next artifact with a longer name is refused where it is
 * named rather than partway through a bootstrap.
 *
 * The abbreviation is also what tells the two forms apart, so nothing marks an
 * identity as one: `bl-app-dev-api-run` and `boxlite-dev-api` cannot be
 * confused for each other, and a prefix saying "identity" would be a third
 * thing to keep in step.
 */

/** A GCP service account id: 6–30 characters, and the binding limit here. */
export const SERVICE_ACCOUNT_LIMIT = 30

/** A GCP workload identity pool id: 4–32 characters. */
export const POOL_LIMIT = 32

export class NameError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NameError'
  }
}

/** The segments of a name, in order, with the absent ones dropped. */
const joined = (segments: (string | undefined)[]): string => segments.filter(Boolean).join('-')

const assertFits = (name: string, limit: number, what: string): string => {
  if (name.length > limit) {
    throw new NameError(
      `${what} "${name}" is ${name.length} characters and the limit is ${limit}. ` +
        'Shorten a segment rather than dropping one: a name that says less is a name that can collide.',
    )
  }
  return name
}

/**
 * Who may do what: `<appShort>-<stage>-<artifact>-<action>`.
 *
 * `artifact` is absent on an identity that serves the whole stage rather than
 * one workload, and `stage` on one that serves every stage — the image
 * publisher is repository-wide, so a per-stage copy would hold one value twice.
 *
 * Checked against the limit here rather than at the call sites, because the
 * limit is the reason the abbreviation exists.
 */
export const identityFor = ({
  appShort,
  stage,
  artifact,
  action,
}: {
  appShort: string
  stage?: string
  artifact?: string
  action?: string
}): string => assertFits(joined([appShort, stage, artifact, action]), SERVICE_ACCOUNT_LIMIT, 'A service account id')

/**
 * A pool of identities, named like one: the same form, and the abbreviation for
 * the same reason. Its own limit, which is two characters looser.
 */
export const poolFor = ({
  appShort,
  stage,
  artifact,
}: {
  appShort: string
  stage?: string
  artifact?: string
}): string => assertFits(joined([appShort, stage, artifact]), POOL_LIMIT, 'A workload identity pool id')

/**
 * The thing itself: `<app>-<stage>-<artifact>`.
 *
 * The app in full, because nothing named this way has an identity's length
 * budget — a Cloud Run service takes 49 characters and a secret 255 — and the
 * full name is what a person reading a console sees.
 *
 * `artifact` is absent on what belongs to the stage rather than to one workload:
 * the network, its subnet, its router.
 */
export const instanceFor = ({
  app,
  stage,
  artifact,
}: {
  app: string
  stage: string
  artifact?: string
}): string => joined([app, stage, artifact])
