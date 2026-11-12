import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { ResourceChip } from './ResourceChip'

describe('memory ResourceChip', () => {
  it.each([
    [0.3, 308],
    [0.50098, 514],
    [513 / 1024, 513],
  ])('shows %s GiB as %i allocated MiB', (value, memoryMib) => {
    const markup = renderToStaticMarkup(<ResourceChip resource="memory" value={value} />)
    expect(markup).toContain(`>${memoryMib}</span>`)
    expect(markup).toContain('>MiB</span>')
  })
})
