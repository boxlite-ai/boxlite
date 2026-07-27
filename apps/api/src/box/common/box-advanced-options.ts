export interface LinuxCapabilities {
  add: string[]
  drop: string[]
}

export interface BoxAdvancedOptions {
  capabilities: LinuxCapabilities
}

export function normalizeBoxAdvancedOptions(
  advanced?: {
    capabilities?: {
      add?: readonly string[] | null
      drop?: readonly string[] | null
    } | null
  } | null,
): BoxAdvancedOptions {
  return {
    capabilities: {
      add: [...(advanced?.capabilities?.add ?? [])],
      drop: [...(advanced?.capabilities?.drop ?? [])],
    },
  }
}
