import { NetworkMode } from '../enums/network-mode.enum'
import { allowListFromAllowNet, inboundModeFromPublic, outboundModeFromBlockAll } from './network-policy.util'

describe('network policy translation', () => {
  // Polarity differs per direction: public → enabled, blockAll → disabled.
  it.each([
    [true, NetworkMode.ENABLED],
    [false, NetworkMode.DISABLED],
    [undefined, NetworkMode.DISABLED],
  ])('maps public=%s to inbound %s', (isPublic, expected) => {
    expect(inboundModeFromPublic(isPublic)).toBe(expected)
  })

  it.each([
    [true, NetworkMode.DISABLED],
    [false, NetworkMode.ENABLED],
  ])('maps networkBlockAll=%s to outbound %s', (blockAll, expected) => {
    expect(outboundModeFromBlockAll(blockAll)).toBe(expected)
  })

  it.each([
    [['api.openai.com', '10.0.0.0/8'], 'api.openai.com,10.0.0.0/8'],
    [[], undefined],
    [null, undefined],
    [undefined, undefined],
  ])('joins %j back to the wire shape', (allowNet, expected) => {
    expect(allowListFromAllowNet(allowNet)).toBe(expected)
  })
})
