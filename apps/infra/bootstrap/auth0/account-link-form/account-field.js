// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// Auth0 Forms custom field for the account link Form: the address being
// linked, greyed out and not editable, the way the login page shows an
// identifier it will not let you change. It also dresses the page like the
// login page, adding its font, logo and styles as page elements, which reach
// every component on the page; the custom field's own CSS setting is not
// documented to.
function linkAccountField(context) {
  const input = document.createElement('input')
  input.type = 'email'
  input.disabled = true
  input.className = 'bl-link-account'

  function addStyles() {
    if (document.getElementById('bl-link-styles')) return
    const fontUrl = __LINK_FONT_URL_JSON__
    const style = document.createElement('style')
    style.id = 'bl-link-styles'
    // Forms already name the face `ulp-font`; defining it gives every
    // component the login page's font.
    const face = fontUrl ? `@font-face { font-family: 'ulp-font'; src: url('${fontUrl}') format('woff2'); }\n` : ''
    style.textContent = face + __LINK_FORM_CSS_JSON__
    document.head.appendChild(style)
  }

  function addLogo() {
    const logoUrl = __LINK_LOGO_URL_JSON__
    const intro = document.querySelector('.af-componentId-intro')
    if (!logoUrl || !intro || document.getElementById('bl-link-logo')) return
    const logo = document.createElement('img')
    logo.id = 'bl-link-logo'
    logo.src = logoUrl
    logo.alt = 'BoxLite'
    intro.before(logo)
  }

  // The address and the mode arrive as params, `{{vars.address}}` and
  // `{{vars.mode}}` resolved from the Action's render. Forms throws until it
  // has resolved the params, and calls update() once it has.
  function showParams() {
    let params
    try {
      params = context.custom.getParams()
    } catch {
      return
    }
    const address = params?.address
    input.value = typeof address === 'string' && !address.includes('{{') ? address : ''
    // In code mode the page asks for no password: its field stays, hidden.
    document.documentElement.classList.toggle('bl-link-code', params?.mode === 'code')
  }

  return {
    init() {
      addStyles()
      setTimeout(addLogo, 0)
      showParams()
      return input
    },
    // Forms calls update() when it updates the step's content, so a heading
    // rendered after init() still gets the logo.
    update() {
      addLogo()
      showParams()
    },
    getValue() {
      return input.value
    },
  }
}
