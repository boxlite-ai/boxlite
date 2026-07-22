/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

// 计费费率（演示值，对齐行业水位线 e2b/Daytona；真实由后台价目版本动态下发）
// CPU $0.0504/vCPU·hr, RAM $0.0162/GiB·hr, Disk $0.000108/GiB·hr(≈ wall存在态)
export const RATES = {
  cpuPerVcpuHr: 0.0504,
  ramPerGiBHr: 0.0162,
  diskPerGiBHr: 0.000108,
}

export type BoxSpec = { cpu: number; memory: number; disk: number }

export function boxHourlyCost({ cpu, memory, disk }: BoxSpec) {
  const cpuCost = cpu * RATES.cpuPerVcpuHr
  const ramCost = memory * RATES.ramPerGiBHr
  const diskCost = disk * RATES.diskPerGiBHr
  return { cpuCost, ramCost, diskCost, total: cpuCost + ramCost + diskCost }
}

export const fmtUsd = (v: number, digits = 4) => `$${v.toFixed(digits)}`
