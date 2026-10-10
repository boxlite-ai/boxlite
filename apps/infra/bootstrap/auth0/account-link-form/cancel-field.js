// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

// Auth0 Forms custom field for the account link Form: the "Don't want to link?
// Cancel" line under Continue. Cancel answers "cancel" and moves the Form
// forward through context.form.goForward(), as Continue does; that needs no
// password, since the Form leaves that field optional, and carries this answer
// to the Action ahead of any password the browser filled in. A Jump button
// would skip the step without collecting any field.
// Loading the same render of the page a second time, a refresh or the address
// opened in another tab, does the same.
function linkCancelField(context) {
  let cancelled = false
  let shown = false
  let checked = false

  function cancel() {
    cancelled = true
    context.form.goForward()
  }

  function reloaded() {
    const [navigation] = window.performance?.getEntriesByType?.('navigation') ?? []
    return navigation?.type === 'reload'
  }

  // The Action gives every render a fresh id, so a second load of one id is a
  // refresh or a copied address, never a new render.
  function loadedBefore(render) {
    if (typeof render !== 'string' || render === '' || render.includes('{{')) return reloaded()
    try {
      const key = `bl-link-render:${render}`
      const seen = window.localStorage.getItem(key) !== null
      window.localStorage.setItem(key, String(Date.now()))
      return seen || reloaded()
    } catch {
      return reloaded()
    }
  }

  // The id arrives as the `render` param. Forms throws until it has resolved
  // the params and calls update() once it has; the check runs once, after the
  // line is on the page.
  function checkLoad() {
    if (!shown || checked) return
    let params
    try {
      params = context.custom.getParams()
    } catch {
      return
    }
    checked = true
    if (loadedBefore(params?.render)) setTimeout(cancel, 0)
  }

  return {
    init() {
      const line = document.createElement('p')
      line.className = 'bl-link-cancel'
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = 'Cancel'
      button.addEventListener('click', cancel)
      line.append("Don't want to link? ", button)
      shown = true
      checkLoad()
      return line
    },
    update() {
      checkLoad()
    },
    getValue() {
      return cancelled ? 'cancel' : ''
    },
  }
}
