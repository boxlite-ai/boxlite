/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

export type BoxImageOption = {
  id: string
  name: string
  ref: string
  isDefault: boolean
}

const CLOUD_BOX_IMAGES = [
  { id: 'base', name: 'Base', ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:20260605-p0-r3', isDefault: true },
  { id: 'python', name: 'Python', ref: 'ghcr.io/boxlite-ai/boxlite-agent-python:20260605-p0-r3', isDefault: false },
  { id: 'node', name: 'Node.js', ref: 'ghcr.io/boxlite-ai/boxlite-agent-node:20260605-p0-r3', isDefault: false },
] as const satisfies readonly BoxImageOption[]

const LOCAL_BOX_IMAGES = [
  { id: 'base', name: 'Base', ref: 'ghcr.io/boxlite-ai/boxlite-agent-base:v0.1.0', isDefault: true },
] as const satisfies readonly BoxImageOption[]

export function getBoxImageOptions(environment: string | undefined): readonly BoxImageOption[] {
  return environment === 'local' ? LOCAL_BOX_IMAGES : CLOUD_BOX_IMAGES
}

export function getDefaultBoxImage(images: readonly BoxImageOption[]): BoxImageOption {
  return images.find((image) => image.isDefault) ?? images[0]
}

export function resolveCreateBoxImageRef(imageRef: string): string | undefined {
  return imageRef || undefined
}
