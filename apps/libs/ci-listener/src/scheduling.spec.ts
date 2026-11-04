/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { ExecutionScope } from './execution/model'
import { FairSelection } from './scheduling'

describe('CI shared fair selection', () => {
  const scope = (tenant: string, account: number): ExecutionScope => ({
    binding: 'binding',
    generation: 1,
    organization: tenant,
    actor: 'actor',
    installation: { id: account, account: { id: account, login: 'owner', type: 'User' } },
    runners: {
      kind: 'repository',
      repository: { id: account, owner: { id: account, login: 'owner' }, name: 'repo', private: true },
      allowPublic: false,
    },
  })
  it('gives tenants equal turns even when one supplies many accounts or repositories', () => {
    const selection = new FairSelection(),
      values = Array.from({ length: 100 }, (_, i) => ({ scope: scope('large', i + 1), value: 'large-' + i }))
    values.push({ scope: scope('small', 200), value: 'small' })
    for (let i = 0; i < 5; i++) expect(selection.take(values, 2)).toContain('small')
  })
  it('rotates queued jobs within an account and returns at most one per account per round', () => {
    const selection = new FairSelection(),
      values = [1, 2, 3].map((value) => ({ scope: scope('tenant', 1), value }))
    expect(selection.take(values, 32)).toEqual([1])
    expect(selection.take(values, 32)).toEqual([2])
    expect(selection.take(values, 32)).toEqual([3])
  })
  it('continues after the head account exhausts its turn and handles an empty snapshot', () => {
    const selection = new FairSelection()
    expect(selection.take([], 32)).toEqual([])
    expect(
      selection.take(
        [1, 2, 3].map((value) => ({ scope: scope('tenant', value), value })),
        32,
      ),
    ).toHaveLength(3)
  })
})
