/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ImageCatalog } from '@/components/images/ImageCatalog'
import { RegistriesPanel } from '@/components/images/RegistriesPanel'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RoutePath } from '@/enums/RoutePath'
import React from 'react'
import { useLocation, useNavigate } from 'react-router-dom'

export type ImagesTab = 'images' | 'registries'

/**
 * Images, and the private registries boxes may pull them from.
 *
 * The two are one page with two tabs: a reader who needs a private image is
 * already here, and the API nests registries under images the same way. Each
 * tab is a route, so a box's pull error can link straight to the second one.
 */
const Images: React.FC<{ tab: ImagesTab }> = ({ tab }) => {
  const navigate = useNavigate()
  const { search } = useLocation()

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-3 lg:mb-[22px]">
        <h1 className="font-display text-page font-semibold text-foreground">Images</h1>
        <Tabs
          value={tab}
          onValueChange={(value) =>
            navigate(value === 'registries' ? `${RoutePath.IMAGE_REGISTRIES}${search}` : RoutePath.IMAGES)
          }
        >
          <TabsList variant="segmented">
            <TabsTrigger value="images">Images</TabsTrigger>
            <TabsTrigger value="registries">Private registries</TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      {tab === 'images' ? <ImageCatalog /> : <RegistriesPanel />}
    </div>
  )
}

export default Images
