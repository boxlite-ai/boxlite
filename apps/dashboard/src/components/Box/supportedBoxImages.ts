export const SUPPORTED_BOX_IMAGES = [
  {
    id: 'base',
    name: 'Base',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-base-v2:v0.9.5',
    isDefault: true,
  },
  {
    id: 'python',
    name: 'Python',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-python-v2:v0.9.5',
    isDefault: false,
  },
  {
    id: 'node',
    name: 'Node.js',
    ref: 'ghcr.io/boxlite-ai/boxlite-agent-node-v2:v0.9.5',
    isDefault: false,
  },
] as const
