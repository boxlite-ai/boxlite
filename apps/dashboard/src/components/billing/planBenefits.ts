/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

// Notion 11·16 subscription design, with the user's PAYG and Max Boxes clarifications.
// Higher tiers include lower-tier capabilities (product clarification, 2026-11-17).
// null means unspecified, not unsupported. Inherited quantities are minimums unless explicitly documented.
type BenefitRow = { label: string; values: readonly [string | null, string | null, string | null] }
type BenefitGroup = { title: string; rows: BenefitRow[] }

export const PLAN_PRESENTATION = [
  { name: 'Pay as you go', priceCents: 0 },
  { name: 'Starter', priceCents: 500 },
  { name: 'Team', priceCents: 10000 },
] as const

// Names identify the legacy and replacement tiers; API order is not an identity.
export function planTierIndex(name: string): number {
  switch (name.toLowerCase().replace(/[\s_-]/g, '')) {
    case 'nosubscription':
    case 'free':
    case 'payg':
    case 'payasyougo':
      return 0
    case 'go':
    case 'starter':
      return 1
    case 'team':
      return 2
    default:
      return -1
  }
}

export const PLAN_BOX_LIMITS = [
  { cpu: 1, memory: 2, disk: 10 },
  { cpu: 2, memory: 4, disk: 20 },
  { cpu: 16, memory: 32, disk: 100 },
] as const

export const PLAN_BENEFITS: BenefitGroup[] = [
  {
    title: 'Resource limits',
    rows: [
      { label: 'Max Boxes', values: ['20', '40', '1,000'] },
      {
        label: 'Max Box size',
        values: PLAN_BOX_LIMITS.map(({ cpu, memory, disk }) => `${cpu}C · ${memory}G · ${disk}G`) as [
          string,
          string,
          string,
        ],
      },
      { label: 'Max concurrency', values: ['2', '4', '1,000'] },
    ],
  },
  {
    title: 'Data retention when overdue',
    rows: [
      {
        label: 'Retention reference point',
        values: ['Payment becomes overdue', 'Subscription ends', 'Subscription ends'],
      },
      { label: 'Maximum time after that point', values: ['24 hours', '48 hours', '72 hours'] },
    ],
  },
  {
    title: 'Development & networking',
    rows: [
      { label: 'Public access', values: ['URL for every Box', 'URL for every Box', 'URL for every Box'] },
      { label: 'CI projects', values: [null, 'Unlimited', 'Unlimited'] },
      { label: 'CI runner concurrency', values: [null, 'Shares Box concurrency', 'Shares Box concurrency'] },
      { label: 'Managed domains', values: [null, '1', '5'] },
      { label: 'Bring your own domains', values: [null, null, '10'] },
      { label: 'Disk read/write bandwidth', values: [null, null, 'Higher bandwidth'] },
      { label: 'Network ingress/egress', values: [null, null, 'Higher bandwidth'] },
    ],
  },
  {
    title: 'Storage, images & virtualization',
    rows: [
      { label: 'Volumes', values: [null, null, 'Included'] },
      { label: 'High-performance volumes', values: [null, null, 'Improved POSIX compatibility'] },
      { label: 'Hosted custom images', values: [null, null, '20'] },
      { label: 'Image warm-up size', values: [null, null, 'Up to 100G'] },
      { label: 'Nested virtualization', values: [null, null, 'Included'] },
      { label: 'Docker in Box', values: [null, null, 'Included'] },
      { label: 'Docker Swarm', values: [null, null, 'Included'] },
    ],
  },
  {
    title: 'Observability & management',
    rows: [
      { label: 'Hosted secrets', values: ['2', '5', 'Unlimited'] },
      { label: 'Box usage dashboard', values: ['Included', 'Included', 'Included'] },
      { label: 'Log retention', values: ['Included', 'Included', 'Included'] },
      { label: 'Real-time log export', values: [null, null, 'Included'] },
      { label: 'Organization members', values: [null, null, '20'] },
    ],
  },
  {
    title: 'Coming soon',
    rows: [
      { label: 'API key usage limits', values: [null, null, 'Coming soon'] },
      { label: 'Enterprise SSO', values: [null, null, 'Coming soon'] },
    ],
  },
]
