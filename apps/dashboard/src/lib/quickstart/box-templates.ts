/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

export const TEMPLATE_CATEGORIES = [
  'All',
  'Code',
  'Browser',
  'Data',
  'Documents & Media',
  'Search & Storage',
  'Testing',
] as const

export interface BoxTemplate {
  id: string
  name: string
  category: Exclude<(typeof TEMPLATE_CATEGORIES)[number], 'All'>
  description: string
  image: string
  cpu: number
  memoryGiB: number
  diskGiB?: number
  startup?: { entrypoint: string[]; cmd: string[] }
  requiredEnv?: { key: string; label: string }
  preparation?: string
  access: string
}

// Public OCI references; image pulls remain subject to upstream availability and runner architecture.
export const BOX_TEMPLATES: BoxTemplate[] = [
  {
    id: 'python',
    name: 'Python',
    category: 'Code',
    description: 'Run Python scripts and work with JSON.',
    image: 'docker.io/library/python:3.12-slim',
    cpu: 2,
    memoryGiB: 2,
    access: 'Shell · Python',
  },
  {
    id: 'node',
    name: 'Node.js',
    category: 'Code',
    description: 'Run JavaScript and start your own web project.',
    image: 'docker.io/library/node:22-bookworm',
    cpu: 2,
    memoryGiB: 2,
    access: 'Shell · Node.js',
  },
  {
    id: 'go',
    name: 'Go',
    category: 'Code',
    description: 'Compile and run Go programs.',
    image: 'docker.io/library/golang:1.24-bookworm',
    cpu: 2,
    memoryGiB: 2,
    access: 'Shell · Go compiler',
  },
  {
    id: 'rust',
    name: 'Rust',
    category: 'Code',
    description: 'Compile and run Rust programs.',
    image: 'docker.io/library/rust:1-bookworm',
    cpu: 2,
    memoryGiB: 2,
    access: 'Shell · Rust compiler',
  },
  {
    id: 'linux',
    name: 'Debian',
    category: 'Code',
    description: 'A minimal Debian environment for shell and file tasks.',
    image: 'docker.io/library/debian:bookworm-slim',
    cpu: 2,
    memoryGiB: 2,
    access: 'Shell · Debian',
  },
  {
    id: 'uv',
    name: 'uv',
    category: 'Code',
    description: 'Manage Python dependencies and run projects with uv.',
    image: 'docker.io/astral/uv:python3.12-bookworm-slim',
    cpu: 2,
    memoryGiB: 2,
    access: 'Terminal \u00b7 Python 3.12 and uv',
    startup: {
      entrypoint: ['/bin/sh'],
      cmd: ['-c', 'while :; do sleep 3600; done'],
    },
  },
  {
    id: 'bun',
    name: 'Bun',
    category: 'Code',
    description: 'Run JavaScript, TypeScript and Bun tests.',
    image: 'docker.io/oven/bun:1',
    cpu: 2,
    memoryGiB: 2,
    access: 'Terminal \u00b7 Bun runtime and test runner',
    startup: {
      entrypoint: ['/bin/sh'],
      cmd: ['-c', 'while :; do sleep 3600; done'],
    },
  },
  {
    id: 'maven',
    name: 'Maven',
    category: 'Code',
    description: 'Build and run Java projects with Maven and JDK 21.',
    image: 'docker.io/library/maven:3-eclipse-temurin-21-alpine',
    cpu: 2,
    memoryGiB: 2,
    access: 'Terminal \u00b7 Maven and Eclipse Temurin 21',
    startup: {
      entrypoint: ['/bin/sh'],
      cmd: ['-c', 'while :; do sleep 3600; done'],
    },
  },
  {
    id: 'gcc',
    name: 'GCC',
    category: 'Code',
    description: 'Compile and run C and C++ programs.',
    image: 'docker.io/library/gcc:trixie',
    cpu: 2,
    memoryGiB: 2,
    access: 'Terminal \u00b7 GCC and G++',
    startup: {
      entrypoint: ['/bin/sh'],
      cmd: ['-c', 'while :; do sleep 3600; done'],
    },
  },
  {
    id: 'browserless',
    name: 'Browserless Chromium',
    category: 'Browser',
    description: 'Render HTML and capture screenshots through an HTTP API.',
    image: 'ghcr.io/browserless/chromium:latest',
    cpu: 2,
    memoryGiB: 4,
    access: 'HTTP API \u00b7 port 3000 \u00b7 PNG screenshots validated',
    requiredEnv: {
      key: 'TOKEN',
      label: 'Access token',
    },
    preparation:
      'An access token is generated automatically in the Box’s TOKEN environment variable. Use it when calling the browser API. The first image download can take longer than other templates.',
  },
  {
    id: 'crawl4ai',
    name: 'Crawl4AI',
    category: 'Browser',
    description: 'Extract webpage content into Markdown with Python.',
    image: 'docker.io/unclecode/crawl4ai:latest',
    cpu: 2,
    memoryGiB: 4,
    access: 'Python API · browser-assisted scraping',
  },
  {
    id: 'lightpanda',
    name: 'Lightpanda',
    category: 'Browser',
    description: 'Fetch HTML with a lightweight headless browser.',
    image: 'docker.io/lightpanda/browser:nightly',
    cpu: 2,
    memoryGiB: 2,
    access: 'CLI · HTML fetching; remote CDP not validated',
  },
  {
    id: 'jupyter',
    name: 'JupyterLab',
    category: 'Data',
    description: 'Execute Python notebooks with a Jupyter environment.',
    image: 'quay.io/jupyter/base-notebook:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'Notebook execution · web login page checked',
  },
  {
    id: 'scipy',
    name: 'Jupyter SciPy Notebook',
    category: 'Data',
    description: 'Analyze tables and generate plots with pandas and SciPy.',
    image: 'quay.io/jupyter/scipy-notebook:latest',
    cpu: 2,
    memoryGiB: 4,
    access: 'Python · pandas, SciPy, scikit-learn, matplotlib',
  },
  {
    id: 'r',
    name: 'Jupyter R Notebook',
    category: 'Data',
    description: 'Analyze data and generate plots with R and tidyverse.',
    image: 'quay.io/jupyter/r-notebook:latest',
    cpu: 2,
    memoryGiB: 4,
    access: 'R · tidyverse; notebook UI not validated',
  },
  {
    id: 'gotenberg',
    name: 'Gotenberg',
    category: 'Documents & Media',
    description: 'Convert HTML into PDF through an HTTP API.',
    image: 'docker.io/gotenberg/gotenberg:8',
    cpu: 2,
    memoryGiB: 2,
    access: 'HTTP API · HTML-to-PDF; Office conversion not validated',
  },
  {
    id: 'tika',
    name: 'Apache Tika',
    category: 'Documents & Media',
    description: 'Extract text from documents through an HTTP API.',
    image: 'docker.io/apache/tika:latest-full',
    cpu: 2,
    memoryGiB: 2,
    access: 'HTTP API · document text extraction',
  },
  {
    id: 'ocr',
    name: 'OCRmyPDF',
    category: 'Documents & Media',
    description: 'Turn scanned PDFs into searchable PDFs and text.',
    image: 'docker.io/jbarlow83/ocrmypdf-alpine:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'CLI · English OCR validated',
  },
  {
    id: 'pandoc',
    name: 'Pandoc',
    category: 'Documents & Media',
    description: 'Convert Markdown into HTML and PDF documents.',
    image: 'docker.io/pandoc/latex:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'CLI · document conversion',
  },
  {
    id: 'ffmpeg',
    name: 'FFmpeg',
    category: 'Documents & Media',
    description: 'Generate video, inspect media and extract frames.',
    image: 'docker.io/jrottenberg/ffmpeg:7.1-ubuntu2404',
    cpu: 2,
    memoryGiB: 2,
    access: 'CLI · FFmpeg and ffprobe',
  },
  {
    id: 'qdrant',
    name: 'Qdrant',
    category: 'Search & Storage',
    description: 'Store vectors and run similarity searches.',
    image: 'docker.io/qdrant/qdrant:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'HTTP API · vector collections and queries',
  },
  {
    id: 'pgvector',
    name: 'PostgreSQL + pgvector',
    category: 'Search & Storage',
    description: 'Combine PostgreSQL tables with vector queries.',
    image: 'docker.io/pgvector/pgvector:pg18-trixie',
    cpu: 2,
    memoryGiB: 2,
    access: 'SQL · PostgreSQL + pgvector',
    requiredEnv: { key: 'POSTGRES_PASSWORD', label: 'PostgreSQL password' },
    preparation:
      'A password is generated in the Box’s POSTGRES_PASSWORD environment variable. Use it to connect to PostgreSQL.',
  },
  {
    id: 'valkey',
    name: 'Valkey',
    category: 'Search & Storage',
    description: 'Read and write temporary key-value state.',
    image: 'docker.io/valkey/valkey:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'CLI / protocol · key-value storage',
  },
  {
    id: 'wiremock',
    name: 'WireMock',
    category: 'Testing',
    description: 'Create mock HTTP endpoints for integration tests.',
    image: 'docker.io/wiremock/wiremock:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'HTTP API · stub registration and requests',
  },
  {
    id: 'k6',
    name: 'k6',
    category: 'Testing',
    description: 'Run scripted HTTP checks and load-test workloads.',
    image: 'docker.io/grafana/k6:latest',
    cpu: 2,
    memoryGiB: 2,
    access: 'CLI · single-request smoke test validated',
  },
]

export const boxTemplateFor = (id: string) => BOX_TEMPLATES.find((item) => item.id === id)

// A conservative reference guard for public image templates; registry availability,
// credentials and architecture are checked by the real image pull service.
export function validTemplateImage(value: string): boolean {
  return (
    value.length <= 256 &&
    /^[a-z0-9][a-z0-9._:/-]*(?:@sha256:[a-f0-9]{64})?$/i.test(value) &&
    !value.includes('://') &&
    !value.includes('..')
  )
}
