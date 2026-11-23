import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { Container, Search } from './icon'

describe('shared thin-line icons', () => {
  it('renders resource icons as thin outlines by default', () => {
    const markup = renderToStaticMarkup(<Container aria-label="Box" className="size-6" />)
    expect(markup).toContain('stroke-width="1.3"')
    expect(markup).toContain('fill="none"')
    expect(markup).toContain('aria-label="Box"')
    expect(markup).toContain('size-6')
  })

  it('preserves explicit stroke and size props', () => {
    const markup = renderToStaticMarkup(<Search strokeWidth={1} size={18} />)
    expect(markup).toContain('stroke-width="1"')
    expect(markup).toContain('width="18"')
    expect(markup).toContain('height="18"')
  })
})
