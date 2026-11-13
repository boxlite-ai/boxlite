/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { BOXLITE_CUSTOM_IMAGE_DOCS_URL } from '@/constants/ExternalLinks'
import { ImageCatalog } from '@/components/images/ImageCatalog'
import { RegistriesPanel } from '@/components/images/RegistriesPanel'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { RoutePath } from '@/enums/RoutePath'
import React, { useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { usePageTitle } from '@/hooks/usePageTitle'

export type ImagesTab = 'images' | 'registries'

/**
 * Images, and the private registries boxes may pull them from.
 *
 * The two are one page with two tabs: a reader who needs a private image is
 * already here, and the API nests registries under images the same way. Each
 * tab is a route, so a box's pull error can link straight to the second one.
 */
const Images: React.FC<{ tab: ImagesTab }> = ({ tab }) => {
  usePageTitle(tab === 'registries' ? 'Private registries' : 'Images')
  const navigate = useNavigate()
  const { search } = useLocation()
  const [showImageHelp, setShowImageHelp] = useState(false)

  return (
    <div className="page-container flex h-[var(--app-content-height,calc(100svh_-_60px))] min-h-0 flex-col pt-5 lg:pt-[26px]">
      <div className="resource-page-header flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-display text-page font-semibold text-foreground">
            {tab === 'registries' ? 'Private registries' : 'Images'}
          </h1>
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
                className="resource-guide-link ml-3 inline"
              >
                How to add an image {showImageHelp ? '−' : '+'}
              </button>
            )}
          </p>
        </div>
        <Tabs
          className="md:hidden"
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
              <Link
                to={`${RoutePath.IMAGE_REGISTRIES}${search}`}
                className="text-foreground underline underline-offset-4"
              >
                Private registries
              </Link>
              . Public images need no credentials.
            </li>
            <li>
              On the Boxes page, choose New Box and enter your container image reference. Box creation permission is
              required.
            </li>
            <li>The image appears here after the Box starts successfully.</li>
          </ol>
          <a
            href={BOXLITE_CUSTOM_IMAGE_DOCS_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="resource-guide-link mt-2 inline-block"
          >
            Use your own image ↗
          </a>
        </div>
      )}

      {tab === 'images' ? <ImageCatalog /> : <RegistriesPanel />}
    </div>
  )
}

export default Images
