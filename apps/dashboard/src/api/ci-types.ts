/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
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
  github_account: string
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
  status: string
  listener_status?: string
  installation_url?: string
  github_account?: string
}
export interface CiConnectConfiguration {
  installation_url: string
  web_connect_available: boolean
}
