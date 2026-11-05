/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { ImageCatalog } from '@/components/images/ImageCatalog'
import { RegistriesPanel } from '@/components/images/RegistriesPanel'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RoutePath } from '@/enums/RoutePath'
import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'

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
  const [showImageHelp, setShowImageHelp] = useState(false)

  return (
    <div className="flex h-[calc(100svh-60px)] min-h-0 flex-col px-4 pt-5 sm:px-6 lg:px-[40px] lg:pt-[26px]">
      <div className="mb-[18px] flex flex-wrap items-end justify-between gap-3 lg:mb-[22px]">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">Images</h1>
          <p className="mt-2 text-body leading-relaxed text-muted-foreground">
            {tab === 'images'
              ? 'Customize your Box environment with container images.'
              : 'Credentials for pulling images from private registries.'}
            {tab === 'images' && (
              <button
                type="button"
                aria-expanded={showImageHelp}
                aria-controls="image-add-guide"
                onClick={() => setShowImageHelp((open) => !open)}
                className="ml-3 inline text-foreground underline underline-offset-4 hover:text-brand focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand"
              >
                How to add an image {showImageHelp ? '−' : '+'}
              </button>
            )}
          </p>
        </div>
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

      {tab === 'images' && (
        <div
          id="image-add-guide"
          hidden={!showImageHelp}
          className="mb-5 border-l border-border pl-3 text-body leading-relaxed text-muted-foreground"
        >
          <ol className="list-inside list-decimal space-y-1">
            <li>
              For a private image, connect its registry in{' '}
              <Link to={RoutePath.IMAGE_REGISTRIES} className="text-foreground underline underline-offset-4">
                Private registries
              </Link>
              . Public images need no credentials.
            </li>
            <li>With Box creation permission, choose New box and enter your container image reference.</li>
            <li>The image appears here after the Box starts successfully.</li>
          </ol>
          <a
            href="https://docs.boxlite.ai/cloud/images"
            target="_blank"
            rel="noopener noreferrer"
            className="mt-2 inline-block text-foreground underline underline-offset-4 hover:text-brand"
          >
            Read the Images guide ↗
          </a>
        </div>
      )}

      {tab === 'images' ? <ImageCatalog /> : <RegistriesPanel />}
    </div>
  )
}

export default Images
