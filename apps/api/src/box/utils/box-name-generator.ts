// Default box-name generation. The word lists and the "{adjective}-{animal}"
// generator live in the shared @boxlite-ai/box-name lib (also used by the
// dashboard's create dialog); this module adds the persistence-side collision
// handling. On the rare collision with the per-org
// @Unique(['organizationId', 'name']) constraint, the caller falls back to
// "{adjective}-{animal}-{boxId}" (see persistWithGeneratedBoxName) — the box
// id is unique by construction, so that single fallback can never collide.

import { generateBoxName } from '@boxlite-ai/box-name'

export { generateBoxName }

// Postgres unique_violation — raised when a generated name hits the per-org
// @Unique(['organizationId', 'name']) constraint.
const PG_UNIQUE_VIOLATION = '23505'

/**
 * Run `persist` with a generated box name: clean first ("cozy-otter"). If that
 * collides with the per-org unique-name constraint, fall back exactly once to
 * "cozy-otter-{boxId}" — the box's own id is unique by construction, so the
 * fallback can never collide. No retry loop, no numeric suffix, no namespace
 * to exhaust.
 *
 * @param boxId - this box's id; appended verbatim on collision. It can contain
 *   uppercase, so the fallback name (unlike the clean base) is not guaranteed
 *   to be a DNS label — keep the id intact rather than lower-casing it, since
 *   the suffix is meant to be the box id.
 * @param persist - performs the insert/update for a candidate name; must throw
 *   a Postgres unique-violation (code 23505) when that name is already taken.
 */
export async function persistWithGeneratedBoxName<T>(
  boxId: string,
  persist: (name: string) => Promise<T>,
): Promise<T> {
  const base = generateBoxName()
  try {
    return await persist(base)
  } catch (error) {
    if ((error as { code?: string })?.code !== PG_UNIQUE_VIOLATION) {
      throw error
    }
    return await persist(`${base}-${boxId}`)
  }
}
