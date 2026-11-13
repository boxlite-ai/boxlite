/* Copyright 2026 BoxLite AI · SPDX-License-Identifier: AGPL-3.0 */

import { TabIcon, type TabIconName } from '@/components/ui/TabIcon'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { useState } from 'react'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { OrganizationRolePermissionsEnum } from '@boxlite-ai/api-client'
import { useCreateBoxMutation } from '@/hooks/mutations/useCreateBoxMutation'
import { useNavigate, generatePath, useSearchParams } from 'react-router-dom'
import { RoutePath } from '@/enums/RoutePath'
import { BOXLITE_CUSTOM_IMAGE_DOCS_URL } from '@/constants/ExternalLinks'
import { getBoxRouteId } from '@/lib/box-identity'
import { TemplateIcon } from './TemplateIcon'
import { AsciiButton } from '@/components/ascii'
import { BOX_TEMPLATES, TEMPLATE_CATEGORIES, boxTemplateFor, validTemplateImage } from '@/lib/quickstart/box-templates'
import { cn } from '@/lib/utils'

const CATEGORY_ICONS: Record<(typeof TEMPLATE_CATEGORIES)[number], TabIconName> = {
  All: 'overview',
  Code: 'code',
  Browser: 'browser',
  Data: 'data',
  'Documents & Media': 'document',
  'Search & Storage': 'search',
  Testing: 'testing',
}

/** Select a public template and create a Box only after membership grants write access. */
export function ConsoleTemplatePicker() {
  const { authenticatedUserHasPermission, authenticatedUserOrganizationMember } = useSelectedOrganization()
  const canCreate = authenticatedUserHasPermission(OrganizationRolePermissionsEnum.WRITE_BOXES)
  const [params] = useSearchParams()
  const [selection, setSelection] = useState<string | null>(
    () => boxTemplateFor(params.get('template') ?? '')?.id ?? null,
  )
  const activeId = selection ?? 'python'
  const createBox = useCreateBoxMutation()
  const navigate = useNavigate()
  const [credential] = useState<string>(() => crypto.randomUUID())
  const [search, setSearch] = useState('')
  const [category, setCategory] = useState('All')
  const [name, setName] = useState(() => params.get('boxName') ?? 'first-box')
  const selected = boxTemplateFor(activeId)
  const envVars = selected?.requiredEnv ? { [selected.requiredEnv.key]: credential } : undefined
  const image = selected?.image ?? ''
  const busy = createBox.isPending
  const visible = BOX_TEMPLATES.filter(
    (item) =>
      (category === 'All' || item.category === category) &&
      `${item.name} ${item.description} ${item.image}`.toLowerCase().includes(search.toLowerCase()),
  )
  // A full navigation reloads permissions while keeping the current console draft.
  const reloadWithSelection = () => {
    const search = new URLSearchParams(params)
    search.set('method', 'console')
    search.set('template', activeId)
    search.set('boxName', name)
    location.assign(`${RoutePath.QUICKSTART}?${search.toString()}`)
  }
  const deploy = async () => {
    if (!canCreate) return
    try {
      const box = await createBox.mutateAsync({
        name,
        image,
        network: { mode: 'enabled' },
        ...selected?.startup,
        envVars,
        resources: { cpu: selected?.cpu ?? 1, memory: selected?.memoryGiB ?? 1, disk: selected?.diskGiB ?? 10 },
      })
      navigate(generatePath(RoutePath.BOX_DETAILS, { boxId: getBoxRouteId(box) }))
    } catch {
      /* Keep the selection available for retry. */
    }
  }
  return (
    <div className="grid min-h-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_300px] lg:gap-8">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display text-body font-semibold">Choose an environment</h3>
          <input
            aria-label="Search templates"
            placeholder="Search templates…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            className="h-8 w-full rounded-none bg-card px-3 font-display text-meta outline-none focus-visible:ring-1 focus-visible:ring-brand sm:w-44"
          />
        </div>
        <p className="mt-2 font-display text-meta text-muted-foreground">
          Public images for coding, data and agent tasks. Start web frameworks from Node.js or Python.
        </p>
        <div
          role="group"
          aria-label="Template category"
          className="my-4 flex flex-wrap items-center gap-x-4 gap-y-2 text-meta text-muted-foreground"
        >
          <Tabs value={category} onValueChange={setCategory} className="min-w-0 max-w-full">
            <TabsList variant="segmented" aria-label="Environment category" className="h-auto flex-wrap gap-1">
              {TEMPLATE_CATEGORIES.map((item) => (
                <TabsTrigger key={item} value={item} className="ml-0 h-9 px-3">
                  <TabIcon name={CATEGORY_ICONS[item]} />
                  {item}
                </TabsTrigger>
              ))}
            </TabsList>
          </Tabs>
        </div>
        <a
          href={BOXLITE_CUSTOM_IMAGE_DOCS_URL}
          target="_blank"
          rel="noopener noreferrer"
          className="resource-guide-link inline-flex items-center gap-1"
        >
          Custom image <span aria-hidden="true">↗</span>
        </a>
        <div className="template-catalog mt-3">
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-3">
            {visible.map((item) => (
              <button
                key={item.id}
                type="button"
                aria-label={`Select ${item.name}`}
                aria-pressed={activeId === item.id}
                disabled={busy}
                onClick={() => {
                  setSelection(item.id)
                  setName(`${item.id}-box`)
                  createBox.reset()
                }}
                className={cn(
                  'group flex min-h-24 flex-col justify-start rounded-none border p-4 text-left transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-brand disabled:opacity-45',
                  activeId === item.id
                    ? 'border-border-selected bg-accent'
                    : 'border-border bg-card hover:border-border-hover hover:bg-accent',
                )}
              >
                <div className="flex items-center gap-2.5">
                  <TemplateIcon id={item.id} />
                  <span className="font-display text-meta font-semibold">{item.name}</span>
                  {activeId === item.id && <span className="ml-auto text-meta text-brand">✓</span>}
                </div>
                <p className="mt-2 font-display text-meta leading-relaxed text-muted-foreground">{item.description}</p>
              </button>
            ))}
          </div>
          {visible.length === 0 && (
            <p className="py-8 text-body text-muted-foreground">
              No templates found. Try another search or see Custom image.
            </p>
          )}
        </div>
      </div>
      <div className="template-detail flex min-w-0 flex-col self-start rounded-none border border-border bg-card px-5 py-5">
        <div className="flex items-start justify-between gap-3">
          <h3 className="flex items-center gap-3 font-display text-em font-semibold">
            <TemplateIcon id={activeId} />
            {selected?.name ?? 'Custom image'}
          </h3>
        </div>
        <label className="mt-5 grid gap-2 font-display text-meta text-muted-foreground">
          Image
          <code className="break-all font-mono text-meta leading-relaxed text-foreground">{image}</code>
        </label>
        <label className="mt-5 grid gap-2 font-display text-meta text-muted-foreground">
          Box name
          <input
            aria-label="Box name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            maxLength={40}
            className="w-full rounded-none border border-border/60 bg-transparent p-2.5 font-mono text-foreground outline-none focus:border-brand disabled:border-transparent disabled:bg-transparent disabled:p-0"
          />
        </label>
        <p className="mt-4 font-mono text-meta text-muted-foreground">
          {selected?.cpu ?? 1} vCPU · {selected?.memoryGiB ?? 1} GiB · {selected?.diskGiB ?? 10} GiB disk · Cloud
        </p>
        {selected?.preparation && (
          <div className="mt-5 font-display text-meta leading-relaxed text-muted-foreground">
            <p className="mb-1 text-foreground">Before you start</p>
            {selected.preparation}
          </div>
        )}
        <p className="mt-4 font-display text-meta text-muted-foreground">
          {selected?.access ?? 'Bring your own runtime and startup configuration.'}
        </p>
        <div className="pt-6">
          <AsciiButton
            variant="primary"
            className="w-full justify-center py-2.5"
            disabled={!canCreate || busy || !validTemplateImage(image) || !/^[a-z0-9][a-z0-9-]{0,39}$/.test(name)}
            onClick={() => void deploy()}
          >
            {busy ? 'Creating Box…' : 'Create Box'}
          </AsciiButton>
          {!canCreate && (
            <div className="mt-2 text-meta text-muted-foreground">
              {authenticatedUserOrganizationMember ? (
                <p>You need Box write permission to create a Box.</p>
              ) : (
                <>
                  <p>Permissions are unavailable. Reload to try again.</p>
                  <AsciiButton type="button" size="sm" className="mt-2" onClick={reloadWithSelection}>
                    Reload page
                  </AsciiButton>
                </>
              )}
            </div>
          )}
          {createBox.isError && (
            <p role="alert" className="mt-2 text-meta text-destructive">
              Could not complete the action. Check the configuration and try again.
            </p>
          )}
        </div>
      </div>
    </div>
  )
}
