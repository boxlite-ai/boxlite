// Default box-name generator. Shape: "{adjective}-{animal}", e.g. "cozy-otter".
//
// Names are kept clean in the common case. On the rare collision with the
// per-org @Unique(['organizationId', 'name']) constraint, the caller falls back
// to "{adjective}-{animal}-{boxId}" (see persistWithGeneratedBoxName) — the box
// id is unique by construction, so that single fallback can never collide.

const ADJECTIVES = [
  'agile', 'amber', 'astute', 'bold', 'bouncy', 'brave', 'breezy', 'brilliant', 'brisk', 'calm',
  'cheery', 'clever', 'cosmic', 'cozy', 'crimson', 'crisp', 'dapper', 'daring', 'darting', 'deft',
  'dreamy', 'dusky', 'eager', 'fierce', 'fluffy', 'fresh', 'gallant', 'gentle', 'gliding', 'glossy',
  'golden', 'hearty', 'hovering', 'hushed', 'indigo', 'intrepid', 'ivory', 'jade', 'jaunty', 'jolly',
  'jovial', 'keen', 'lively', 'lofty', 'lucid', 'lunar', 'mellow', 'mighty', 'mild', 'mystic',
  'neat', 'nebular', 'nimble', 'opal', 'perky', 'placid', 'plucky', 'polished', 'prismatic', 'quick',
  'radiant', 'savvy', 'serene', 'sharp', 'silver', 'sleek', 'snappy', 'snug', 'soaring', 'solar',
  'sparkly', 'starry', 'swift', 'tidy', 'tranquil', 'valiant', 'vibrant', 'vivid', 'witty', 'zippy',
] as const

const ANIMALS = [
  'alpaca', 'badger', 'bat', 'bear', 'beaver', 'bee', 'beluga', 'bluebird', 'bluejay', 'bobcat',
  'bumblebee', 'bunny', 'butterfly', 'calf', 'canary', 'capybara', 'cardinal', 'cat', 'chameleon', 'chick',
  'chickadee', 'chinchilla', 'chipmunk', 'cockatiel', 'corgi', 'cottontail', 'crab', 'cub', 'deer', 'dolphin',
  'dove', 'dragonfly', 'duck', 'duckling', 'eagle', 'falcon', 'fawn', 'ferret', 'finch', 'firefly',
  'flamingo', 'fox', 'frog', 'gecko', 'goldfinch', 'goose', 'gosling', 'guppy', 'hamster', 'hare',
  'hawk', 'hedgehog', 'heron', 'hummingbird', 'joey', 'kangaroo', 'kit', 'kitten', 'koala', 'ladybug',
  'lamb', 'lemur', 'llama', 'lovebird', 'lynx', 'magpie', 'manatee', 'marmot', 'meerkat', 'mole',
  'mouse', 'narwhal', 'nightingale', 'ocelot', 'octopus', 'otter', 'owl', 'owlet', 'panda', 'parakeet',
  'parrot', 'peacock', 'pelican', 'penguin', 'piglet', 'platypus', 'pony', 'porpoise', 'possum', 'puffin',
  'pup', 'puppy', 'quokka', 'rabbit', 'raccoon', 'raven', 'robin', 'salamander', 'seahorse', 'seal',
  'sheep', 'sloth', 'snail', 'sparrow', 'squirrel', 'starfish', 'stingray', 'swallow', 'swan', 'tadpole',
  'tortoise', 'toucan', 'turtle', 'wallaby', 'walrus', 'whale', 'wolf', 'wombat', 'woodpecker', 'wren',
] as const

function pick<T>(arr: readonly T[]): T {
  return arr[Math.floor(Math.random() * arr.length)]
}

/**
 * Generate a default box name like `cozy-otter`. Hyphen- (not underscore-)
 * separated and all-lowercase, so the clean name is a valid DNS label in case
 * box names ever become hostnames.
 */
export function generateBoxName(): string {
  return `${pick(ADJECTIVES)}-${pick(ANIMALS)}`
}

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
