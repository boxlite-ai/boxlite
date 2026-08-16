// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { signalProcessGroup } from '../shared/exec.js'

const DEFAULT_TERMINATION_GRACE_MS = 10_000

export class SstProcessTerminator {
  #activeChild: any
  #killTimer: any
  #signalProcessGroup
  #terminationGraceMs

  constructor({ signalProcess = signalProcessGroup, terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS } = {}) {
    if (!Number.isSafeInteger(terminationGraceMs) || terminationGraceMs <= 0) {
      throw new Error('SST termination grace period must be a positive integer')
    }
    this.#signalProcessGroup = signalProcess
    this.#terminationGraceMs = terminationGraceMs
  }

  attach(child: any) {
    if (this.#activeChild && this.#activeChild !== child) {
      throw new Error('cannot attach SST while another child is active')
    }
    this.#activeChild = child
  }

  interrupt() {
    if (!this.#activeChild || this.#killTimer) return

    // SST handles SIGINT by cancelling and awaiting its detached Pulumi child.
    // Bound that grace period so a stuck process group cannot outlive the wrapper.
    this.#signalProcessGroup(this.#activeChild, 'SIGINT')
    this.#killTimer = setTimeout(() => {
      this.#killTimer = undefined
      this.forceStop()
    }, this.#terminationGraceMs)
    this.#killTimer.unref()
  }

  forceStop() {
    if (!this.#activeChild) return
    this.#signalProcessGroup(this.#activeChild, 'SIGKILL')
  }

  settle(child: any) {
    if (this.#activeChild !== child) return
    if (this.#killTimer) clearTimeout(this.#killTimer)
    this.#killTimer = undefined
    this.#activeChild = undefined
  }
}
