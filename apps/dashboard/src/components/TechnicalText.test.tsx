// @vitest-environment jsdom
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { FormattedBytes, TechnicalText } from './TechnicalText'

describe('TechnicalText', () => {
  it.each([
    ['image', 'ubuntu', 'ubuntu'],
    ['image', 'ubuntu:24.04', 'ubuntu'],
    ['image', 'localhost:5000/team/api:v2', 'api'],
    ['image', 'localhost:5000/team/api', 'api'],
    ['image', 'ghcr.io/team/api@sha256:abc123', 'api'],
    ['image', 'ghcr.io/team/api:v2@sha256:abc123', 'api'],
    ['path', '/srv/models', 'models'],
    ['path', '/srv//models///', 'models'],
    ['path', '/', ''],
    ['path', '///', ''],
    ['path', '', ''],
    ['hostname', 'demo.apps.example.com', 'demo'],
    ['hostname', 'localhost', 'localhost'],
    ['hostname', '[::1]', '[::1]'],
  ] as const)('preserves %s %j and emphasizes %j', (kind, value, name) => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<TechnicalText value={value} kind={kind} />)
    expect(host.textContent).toBe(value)
    expect(host.querySelector('[title]')?.getAttribute('title')).toBe(value)
    expect(host.querySelector('[data-part="name"]')?.textContent).toBe(name)
  })

  it.each([
    [null, '—'],
    [undefined, '—'],
    [0, '0 B'],
    [478150656, '456 MiB'],
  ] as const)('retains the byte formatter contract for %s', (bytes, text) => {
    const host = document.createElement('div')
    host.innerHTML = renderToStaticMarkup(<FormattedBytes bytes={bytes} />)
    expect(host.textContent).toBe(text)
  })
})
