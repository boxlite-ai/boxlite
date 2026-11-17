/* Copyright BoxLite AI, 2026 · SPDX-License-Identifier: AGPL-3.0 */
import { Navigate, useSearchParams } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'

/** A shareable coupon link (`/redeem?code=CODE`) opens the filled-in Wallet coupon form. */
export default function Redeem() {
  const [searchParams] = useSearchParams()
  const target = new URLSearchParams({ tab: 'wallet' })
  const code = searchParams.get('code')
  if (code) target.set('code', code)
  return <Navigate to={`${RoutePath.BILLING}?${target}`} replace />
}
