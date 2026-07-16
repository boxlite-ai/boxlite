/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// Single source of truth for default box names, shared by the api (assigns a
// name when a create request has none) and the dashboard (pre-fills the same
// style of name in the create dialog). Keep it dependency-free: it is consumed
// as source on both sides.

export const BOX_NAME_ADJECTIVES = [
  'agile', 'amber', 'astute', 'bold', 'bouncy', 'brave', 'breezy', 'brilliant', 'brisk', 'calm',
  'cheery', 'clever', 'cosmic', 'cozy', 'crimson', 'crisp', 'dapper', 'daring', 'darting', 'deft',
  'dreamy', 'dusky', 'eager', 'fierce', 'fluffy', 'fresh', 'gallant', 'gentle', 'gliding', 'glossy',
  'golden', 'hearty', 'hovering', 'hushed', 'indigo', 'intrepid', 'ivory', 'jade', 'jaunty', 'jolly',
  'jovial', 'keen', 'lively', 'lofty', 'lucid', 'lunar', 'mellow', 'mighty', 'mild', 'mystic',
  'neat', 'nebular', 'nimble', 'opal', 'perky', 'placid', 'plucky', 'polished', 'prismatic', 'quick',
  'radiant', 'savvy', 'serene', 'sharp', 'silver', 'sleek', 'snappy', 'snug', 'soaring', 'solar',
  'sparkly', 'starry', 'swift', 'tidy', 'tranquil', 'valiant', 'vibrant', 'vivid', 'witty', 'zippy',
] as const

export const BOX_NAME_ANIMALS = [
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
  return `${pick(BOX_NAME_ADJECTIVES)}-${pick(BOX_NAME_ANIMALS)}`
}
