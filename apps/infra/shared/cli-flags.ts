// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/*
 * Long-flag parsing shared by the human-run scripts (`npm run bootstrap`,
 * `npm run login`). One rule in one place: a flag that takes a value must
 * actually carry one, so `--stage --force` fails loudly instead of silently
 * treating `--force` as the stage name.
 */

export function parseFlag(args: any, name: any) {
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === `--${name}`) {
      const value = args[index + 1]
      // A following flag is a missing value, not the value itself.
      if (!value || value.startsWith('-')) throw new Error(`--${name} requires a value`)
      return value
    }
    const inline = args[index].match(new RegExp(`^--${name}=(.*)$`))?.[1]
    if (inline !== undefined) return inline
  }
  return undefined
}

export function hasFlag(args: any, name: any) {
  return args.includes(`--${name}`)
}
