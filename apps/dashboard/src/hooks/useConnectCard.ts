/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */
import { useCallback } from 'react'
import { toast } from 'sonner'
import { useFetchOwnerCheckoutUrlQuery, useIsOwnerCheckoutUrlFetching } from './queries/billingQueries'

export function useConnectCard() {
  const fetchCheckoutUrl = useFetchOwnerCheckoutUrlQuery()
  const isPending = useIsOwnerCheckoutUrlFetching()

  const connectCard = useCallback(async () => {
    const newWindow = window.open('', '_blank')
    try {
      const url = await fetchCheckoutUrl()
      if (newWindow) newWindow.location.href = url
    } catch (error) {
      newWindow?.close()
      toast.error('Failed to fetch checkout url', {
        description: String(error),
      })
    }
  }, [fetchCheckoutUrl])

  return { connectCard, isPending }
}
