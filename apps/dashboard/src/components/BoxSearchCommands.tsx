/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { RoutePath } from '@/enums/RoutePath'
import { useApi } from '@/hooks/useApi'
import { useSelectedOrganization } from '@/hooks/useSelectedOrganization'
import { getBoxDisplayName, getBoxPublicIdLabel, getBoxRouteId } from '@/lib/box-identity'
import { useQuery } from '@tanstack/react-query'
import { Container } from '@/components/ui/icon'
import { useEffect, useMemo, useState } from 'react'
import { generatePath, useNavigate } from 'react-router-dom'
import { CommandConfig, useCommandPalette, useCommandPaletteActions, useRegisterCommands } from './CommandPalette'

// Surfaces live box results inside the command palette: typing a name/ID in the
// global search (⌘K) queries boxes and shows matches that jump to the box detail.
export function BoxSearchCommands() {
  const isOpen = useCommandPalette((state) => state.isOpen)
  const activePageId = useCommandPalette((state) => state.activePageId)
  const search = useCommandPalette((state) => state.searchByPage.get(state.activePageId) ?? '')
  const { boxApi } = useApi()
  const { selectedOrganization } = useSelectedOrganization()
  const { setIsOpen } = useCommandPaletteActions()
  const navigate = useNavigate()

  const [debounced, setDebounced] = useState('')
  useEffect(() => {
    const timeout = setTimeout(() => setDebounced(search.trim()), 200)
    return () => clearTimeout(timeout)
  }, [search])

  const enabled = isOpen && activePageId === 'root' && debounced.length > 0 && !!selectedOrganization

  const { data } = useQuery({
    queryKey: ['command-palette-boxes', selectedOrganization?.id, debounced],
    queryFn: async () =>
      (await boxApi.listBoxesPaginated(selectedOrganization!.id, 1, 6, undefined, debounced)).data,
    enabled,
    staleTime: 15_000,
  })

  const commands = useMemo<CommandConfig[]>(() => {
    if (!enabled || !data?.items?.length) {
      return []
    }
    return data.items.map((box) => ({
      id: `box-search-${box.id}`,
      label: getBoxDisplayName(box),
      icon: <Container className="size-4" />,
      // Tag with the active query so the palette's client-side filter always
      // keeps server-matched results (e.g. ID match when the name differs).
      keywords: [debounced, box.id, getBoxPublicIdLabel(box)],
      onSelect: () => {
        setIsOpen(false)
        navigate(generatePath(RoutePath.BOX_DETAILS, { boxId: getBoxRouteId(box) }))
      },
    }))
  }, [enabled, data, debounced, navigate, setIsOpen])

  useRegisterCommands(commands, { groupId: 'boxes-search', groupLabel: 'Boxes', groupOrder: 0 })

  return null
}
