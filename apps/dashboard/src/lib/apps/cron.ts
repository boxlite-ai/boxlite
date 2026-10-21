/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

// Five-field cron (UTC, as the control plane runs it) in words, for the common shapes an agent
// writes. Anything else is shown as the expression itself.

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
const pad = (n: number) => String(n).padStart(2, '0')
const isNum = (v: string) => /^\d+$/.test(v)

export function describeCron(cron: string): string {
  const parts = cron.trim().split(/\s+/)
  if (parts.length !== 5) return cron
  const [min, hour, dom, month, dow] = parts
  const anyDay = dom === '*' && month === '*'
  if (parts.every((p) => p === '*')) return 'every minute'
  const step = /^\*\/(\d+)$/.exec(min)
  if (step && hour === '*' && anyDay && dow === '*') return `every ${step[1]} minutes`
  if (isNum(min) && hour === '*' && anyDay && dow === '*') return `every hour at :${pad(Number(min))}`
  const hourStep = /^\*\/(\d+)$/.exec(hour)
  if (isNum(min) && hourStep && anyDay && dow === '*') return `every ${hourStep[1]} hours at :${pad(Number(min))}`
  if (isNum(min) && isNum(hour)) {
    const at = `${pad(Number(hour))}:${pad(Number(min))} UTC`
    if (anyDay && dow === '*') return `every day at ${at}`
    if (anyDay && isNum(dow)) return `every ${DAYS[Number(dow) % 7]} at ${at}`
    if (anyDay && dow === '1-5') return `weekdays at ${at}`
    if (isNum(dom) && month === '*' && dow === '*') return `day ${dom} of every month at ${at}`
  }
  return cron
}
