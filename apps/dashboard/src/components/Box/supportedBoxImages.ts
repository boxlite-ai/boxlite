export const SUPPORTED_BOX_IMAGES = [
  {
    id: 'base',
    name: 'Base',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0',
    isDefault: true,
  },
  {
    id: 'python',
    name: 'Python',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-python:v0.1.0',
    isDefault: false,
  },
  {
    id: 'node',
    name: 'Node.js',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-node:v0.1.0',
    isDefault: false,
  },
] as const
