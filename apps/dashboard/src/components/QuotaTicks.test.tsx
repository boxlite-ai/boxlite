// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { QuotaTicks } from './QuotaTicks'

describe('QuotaTicks', () => {
  it.each([null, undefined, 0, -1, Infinity, NaN])('omits an unavailable or invalid limit %s', (limit) => {
    expect(renderToStaticMarkup(<QuotaTicks used={3} limit={limit} />)).toBe('')
  })
  it.each([-1, Infinity, NaN])('omits invalid usage %s', (used) => {
    expect(renderToStaticMarkup(<QuotaTicks used={used} limit={20} />)).toBe('')
  })
  it.each([
    [0, 20, ['0%', '0%', '0%', '0%', '0%', '0%', '0%', '0%', '0%', '0%']],
    [3, 20, ['100%', '50%', '0%', '0%', '0%', '0%', '0%', '0%', '0%', '0%']],
    [25, 20, Array(10).fill('100%')],
  ])('draws %s of %s without fabricating extra ticks', (used, limit, widths) => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<QuotaTicks used={used as number} limit={limit as number} />)
    expect([...host.querySelectorAll<HTMLElement>('.quota-tick > span')].map((node) => node.style.width)).toEqual(
      widths,
    )
    expect(host.firstElementChild?.getAttribute('aria-hidden')).toBe('true')
    expect(host.querySelector('[tabindex], button, a')).toBeNull()
    expect(host.textContent).toBe('')
  })
})
