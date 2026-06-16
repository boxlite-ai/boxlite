export const SUPPORTED_BOX_IMAGES = [
  {
    id: 'base',
    name: 'Base',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0', // Default generic image shown first in Create Box.
    isDefault: true,
  },
  {
    id: 'python',
    name: 'Python',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0', // Python option for users who need Python tooling preinstalled.
    isDefault: false,
  },
  {
    id: 'node',
    name: 'Node.js',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0', // Node option for users who need Node tooling preinstalled.
    isDefault: false,
  },
] as const
