import { allowListFromAllowNet } from './network-policy.util'

describe('network policy translation', () => {
  it.each([
    [['api.openai.com', '10.0.0.0/8'], 'api.openai.com,10.0.0.0/8'],
    [[], undefined],
    [null, undefined],
    [undefined, undefined],
  ])('joins %j back to the wire shape', (allowNet, expected) => {
    expect(allowListFromAllowNet(allowNet)).toBe(expected)
  })
})
