/*
 * Copyright 2026 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

import { type Box } from '@boxlite-ai/api-client'
import { Check, Copy } from '@/components/ui/icon'
import { useMemo, useState, type RefCallback } from 'react'
import { generatePath, Link } from 'react-router-dom'
import { toast } from 'sonner'
import { RoutePath } from '@/enums/RoutePath'
import { useImagesQuery } from '@/hooks/queries/useImagesQuery'
import { useVolumesQuery } from '@/hooks/queries/useVolumesQuery'
import { useRegions } from '@/hooks/useRegions'
import { getBoxPublicId, getBoxPublicIdLabel } from '@/lib/box-identity'
import { catalogNameOf, registryHostOf } from '@/lib/image-ref'
import { copyToClipboard } from '@/lib/copy-text'
import { getRelativeTimeString } from '@/lib/utils'
import { BoxResourceSummary } from './BoxResourceSummary'
import { BoxNetworkSection } from './BoxNetworkSection'
import { BoxDetailField, BoxDetailHeading } from './BoxDetailFields'

/** Overview properties and network settings; catalog queries belong only to Overview. */
export function BoxOverview({
  box,
  canManage,
  sshStatusRef,
}: {
  box: Box
  canManage: boolean
  sshStatusRef: RefCallback<HTMLDivElement>
}) {
  const { getRegionName } = useRegions()
  const [copied, setCopied] = useState(false)
  // Volumes this box mounts, with the stored handle resolved back to a name.
  const { data: allVolumes = [] } = useVolumesQuery()
  // The image the box names is linked once it is in the catalog, which a
  // first start puts it in; a built-in one is matched on its full reference.
  const { data: images = [] } = useImagesQuery()
  const catalogImage = box?.image
    ? images.find((image) =>
        image.curated ? image.curatedRef === box.image : image.name === catalogNameOf(box.image ?? ''),
      )
    : undefined
  const mountedVolumes = useMemo(() => {
    const mounts = (box?.volumes ?? []) as { volumeId: string; mountPath: string; subpath?: string }[]
    return mounts.map((mount) => {
      const match = allVolumes.find((v) => v.id === mount.volumeId || v.name === mount.volumeId)
      return { ...mount, displayName: match?.name ?? mount.volumeId }
    })
  }, [box?.volumes, allVolumes])

  const copyId = async () => {
    const id = box ? getBoxPublicId(box) : null
    if (!id) return
    if (!(await copyToClipboard(id))) {
      toast.error('Could not copy to clipboard')
      return
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1300)
  }

  return (
    <div className="min-w-0 pb-2 pt-1">
      <div className="w-full space-y-4">
        <BoxResourceSummary box={box} />
        <div className="grid items-start gap-4 lg:grid-cols-[minmax(0,1.7fr)_minmax(354px,1fr)]">
          <div className="min-w-0 space-y-4">
            <section aria-label="Box configuration" className="min-w-0 border border-border/50 bg-background">
              <div className="px-4 pb-3 pt-2">
                <BoxDetailHeading title="Configuration" />
                <dl>
                  <BoxDetailField label="Box ID">
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="min-w-0 break-all">{getBoxPublicIdLabel(box)}</span>
                      <button
                        type="button"
                        onClick={copyId}
                        title="Copy Box ID"
                        aria-label="Copy Box ID"
                        className="relative inline-flex size-5 shrink-0 items-center justify-center after:absolute after:-inset-0.5 text-muted-foreground hover:text-foreground"
                      >
                        {copied ? <Check className="size-[14px] text-success" /> : <Copy className="size-[14px]" />}
                      </button>
                    </span>
                  </BoxDetailField>
                  <BoxDetailField label="Image">
                    {box.image ? (
                      catalogImage ? (
                        <Link
                          to={generatePath(RoutePath.IMAGE_DETAILS, {
                            idOrRef: catalogImage.id ?? catalogImage.name,
                          })}
                          className="underline-offset-4 hover:underline"
                        >
                          {box.image}
                        </Link>
                      ) : (
                        box.image
                      )
                    ) : (
                      '—'
                    )}
                  </BoxDetailField>
                  <BoxDetailField label="Region">
                    {(getRegionName(box.target) ?? box.target ?? '—').toUpperCase()}
                  </BoxDetailField>
                </dl>
              </div>
              <dl
                aria-label="Activity"
                className="flex flex-wrap gap-x-5 gap-y-1 bg-muted/30 px-4 py-2 text-meta text-muted-foreground"
              >
                <div className="flex items-baseline gap-1.5">
                  <dt>Created</dt>
                  <dd title={box.createdAt}>{getRelativeTimeString(box.createdAt).relativeTimeString}</dd>
                </div>
                <div className="flex items-baseline gap-1.5">
                  <dt>Last event</dt>
                  <dd title={box.updatedAt}>{getRelativeTimeString(box.updatedAt).relativeTimeString}</dd>
                </div>
              </dl>
            </section>

            {/* Read-only by construction: mounts are fixed when the box is
                  created and there is no attach/detach endpoint, so this
                  answers "where is my data" and nothing more. Stored volumeId
                  may be a name or an id — the API accepts either — so resolve
                  it back to the readable name when we know it. */}
            {mountedVolumes.length > 0 && (
              <section
                aria-label="Box volumes"
                className="min-w-0 border border-border/50 bg-background px-4 pb-2 pt-2"
              >
                <BoxDetailHeading title="Volumes" />
                <table className="w-full table-fixed text-left text-body">
                  <caption className="sr-only">Mounted volumes</caption>
                  <thead>
                    <tr className="border-b border-border/35 text-muted-foreground">
                      <th scope="col" className="pb-2 pr-4 font-normal">
                        Volume
                      </th>
                      <th scope="col" className="pb-2 font-normal">
                        Mount path
                      </th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border/35">
                    {mountedVolumes.map((mount) => (
                      <tr key={`${mount.volumeId}:${mount.mountPath}`}>
                        <td className="py-2 pr-4 align-top font-mono text-body [overflow-wrap:anywhere]">
                          <Link to={RoutePath.VOLUMES} className="underline-offset-4 hover:text-brand hover:underline">
                            {mount.displayName}
                          </Link>
                        </td>
                        <td className="py-2 align-top text-body [overflow-wrap:anywhere]">
                          <code>
                            {mount.mountPath}
                            {mount.subpath ? ` (${mount.subpath})` : ''}
                          </code>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </section>
            )}

            {box.errorReason && (
              <div className="border border-border/50 bg-background px-4 pb-4 pt-2">
                <BoxDetailHeading title="Error" />
                <p className="text-meta leading-relaxed text-destructive-foreground">{box.errorReason}</p>
                {/* The API's wording for a private pull with no credential.
                      The fix is on the registries page, so the error carries the way there. */}
                {box.image && /no registry login/.test(box.errorReason) && (
                  <Link
                    to={`${RoutePath.IMAGE_REGISTRIES}?connect=${encodeURIComponent(registryHostOf(box.image))}`}
                    className="mt-3 inline-block text-meta text-foreground underline underline-offset-4 hover:text-brand"
                  >
                    Connect a registry for {registryHostOf(box.image)} →
                  </Link>
                )}
              </div>
            )}
          </div>
          <section aria-label="Box network" className="min-w-0 border border-border/50 bg-background px-4 pb-4 pt-2">
            <BoxNetworkSection box={box} canManage={canManage}>
              <div ref={sshStatusRef} />
            </BoxNetworkSection>
          </section>
        </div>
      </div>
    </div>
  )
}
