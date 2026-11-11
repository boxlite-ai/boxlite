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
    allow_private_repositories: boolean
    installation_id: number
    installation_settings_url: string
  }[]
}
export interface CiConnectInput {
  account_type?: 'User' | 'Organization'
  select_account?: boolean
  follow_installation: true
  allow_private_repositories: boolean
}
export interface CiWebStart {
  id: string
  expires_at: string
  authorization_url: string
  installation_url?: string
}
export interface CiConnectResult {
  id?: string
  expires_at?: string
  accounts?: {
    installation_id: number | null
    installation_settings_url?: string
    account_id: number
    github_account: string
    account_type: 'User' | 'Organization'
    installed?: boolean
    connected?: boolean
  }[]
  authenticated_account?: string
  authorization_settings_url?: string
  status: string
  listener_status?: string
  installation_url?: string
  github_account?: string
}
export type CiRepositoryContext = { kind: 'binding'; id: string } | { kind: 'grant'; id: string; account: number }
export interface CiRepositoryPage {
  repositories: { id: number; name: string; private: boolean; owner: { id: number; login: string } }[]
  total: number
  page: number
  next_page: number | null
  repository_selection: 'all' | 'selected'
  installation_settings_url: string
}
export interface CiConnectConfiguration {
  web_connect_available?: boolean
  authorization_settings_url?: string
  apps: { account_type: 'User' | 'Organization'; installation_url: string; web_connect_available: boolean }[]
}
