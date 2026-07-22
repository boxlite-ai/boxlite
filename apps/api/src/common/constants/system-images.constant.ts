export const DEFAULT_SYSTEM_IMAGES = {
  base: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3',
  python: 'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3',
  node: 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3',
} as const

export type SystemImages = {
  base: string
  python: string
  node: string
}

export function configuredSystemImages(env: NodeJS.ProcessEnv = process.env): SystemImages {
  return {
    base: env.BOXLITE_SYSTEM_BASE_IMAGE || DEFAULT_SYSTEM_IMAGES.base,
    python: env.BOXLITE_SYSTEM_PYTHON_IMAGE || DEFAULT_SYSTEM_IMAGES.python,
    node: env.BOXLITE_SYSTEM_NODE_IMAGE || DEFAULT_SYSTEM_IMAGES.node,
  }
}
