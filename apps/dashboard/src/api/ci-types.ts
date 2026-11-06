/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import type { Box } from '@boxlite-ai/api-client'

export interface CiCapacity {
  available: boolean
  used: number
  max_concurrent_jobs: number | null
  commerce_limit: number | null
  effective_limit: number | null
}

export interface CiRunners {
  items: Box[]
  total: number
  page: number
  totalPages: number
  capacity: CiCapacity
}

export interface CiSettings {
  available: boolean
  max_concurrent_jobs: number | null
  commerce_limit: number | null
  effective_limit: number | null
  connections: {
    binding_id: string
    github_account: string
    account_type: string
    listener_status: string
    allow_public_repositories: boolean
  }[]
}
export interface CiConnectInput {
  account_type: 'User' | 'Organization'
  follow_installation: true
  allow_public_repositories: boolean
}
export interface CiWebStart {
  id: string
  expires_at: string
  authorization_url: string
  installation_url: string
}
export interface CiConnectResult {
  id?: string
  expires_at?: string
  accounts?: {
    installation_id: number
    account_id: number
    github_account: string
    account_type: 'User' | 'Organization'
  }[]
  status: string
  listener_status?: string
  installation_url?: string
  github_account?: string
}
export interface CiConnectConfiguration {
  apps: { account_type: 'User' | 'Organization'; installation_url: string; web_connect_available: boolean }[]
}
