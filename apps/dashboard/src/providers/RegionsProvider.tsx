/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ReactNode, useCallback, useEffect, useMemo, useState } from 'react'
import { Region } from '@boxlite-ai/api-client'
import { IRegionsContext, RegionsContext } from '@/contexts/RegionsContext'
import { useApi } from '@/hooks/useApi'

type Props = {
  children: ReactNode
}

export function RegionsProvider(props: Props) {
  const { regionsApi } = useApi()

  const [sharedRegions, setSharedRegions] = useState<Region[]>([])

  const getSharedRegions = useCallback(async () => {
    try {
      const regions = (await regionsApi.listSharedRegions()).data
      setSharedRegions(regions)
    } catch (error) {
      // Region names are optional; callers fall back to the region ID.
      console.warn('Failed to fetch shared regions', error)
      setSharedRegions([])
    }
  }, [regionsApi])

  useEffect(() => {
    getSharedRegions()
  }, [getSharedRegions])

  const getRegionName = useCallback(
    (regionId: string): string | undefined => {
      const region = sharedRegions.find((region) => region.id === regionId)
      return region?.name
    },
    [sharedRegions],
  )

  const contextValue: IRegionsContext = useMemo(() => {
    return {
      getRegionName,
    }
  }, [getRegionName])

  return <RegionsContext.Provider value={contextValue}>{props.children}</RegionsContext.Provider>
}
