/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import {
  Command,
  CommandCheckboxItem,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandInputButton,
  CommandList,
} from '@/components/ui/command'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import type { SavedImage } from '@/hooks/queries/useSavedImagesQuery'
import { getSavedImageDisplayName } from '@/lib/saved-image-display'
import { Loader2, X } from 'lucide-react'
import { useState } from 'react'

interface SavedImageFilterProps {
  value: string[]
  onFilterChange: (value: string[] | undefined) => void
  savedImages: SavedImage[]
  isLoading: boolean
}

export function SavedImageFilterIndicator({ value, onFilterChange, savedImages, isLoading }: SavedImageFilterProps) {
  return (
    <div className="flex items-center h-6 gap-0.5 rounded-sm border border-border bg-muted/80 hover:bg-muted/50 text-sm">
      <Popover>
        <PopoverTrigger className="max-w-[160px] overflow-hidden text-ellipsis whitespace-nowrap text-muted-foreground px-2">
          Image: <span className="text-primary font-medium">{value.length} selected</span>
        </PopoverTrigger>

        <PopoverContent className="p-0 w-[240px]" align="start">
          <SavedImageFilter value={value} onFilterChange={onFilterChange} savedImages={savedImages} isLoading={isLoading} />
        </PopoverContent>
      </Popover>

      <button className="h-6 w-5 p-0 border-0 hover:text-muted-foreground" onClick={() => onFilterChange(undefined)}>
        <X className="h-3 w-3" />
      </button>
    </div>
  )
}

export function SavedImageFilter({ value, onFilterChange, savedImages, isLoading }: SavedImageFilterProps) {
  const [searchValue, setSearchValue] = useState('')

  const filteredSavedImages = savedImages.filter((savedImage) => {
    const search = searchValue.trim().toLowerCase()
    if (!search) return true

    return [savedImage.displayName, savedImage.name, savedImage.artifactRef, savedImage.description]
      .filter(Boolean)
      .some((field) => field?.toLowerCase().includes(search))
  })

  const handleSelect = (savedImageName: string) => {
    const newValue = value.includes(savedImageName)
      ? value.filter((name) => name !== savedImageName)
      : [...value, savedImageName]
    onFilterChange(newValue.length > 0 ? newValue : undefined)
  }

  const handleSearchChange = (search: string | number) => {
    setSearchValue(String(search))
  }

  return (
    <Command>
      <CommandInput placeholder="Search..." className="" value={searchValue} onValueChange={handleSearchChange}>
        <CommandInputButton
          onClick={() => {
            onFilterChange(undefined)
            setSearchValue('')
          }}
        >
          Clear
        </CommandInputButton>
      </CommandInput>
      <CommandList>
        {isLoading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="h-4 w-4 animate-spin mr-2" />
            <span className="text-sm text-muted-foreground">Loading images...</span>
          </div>
        ) : (
          <>
            <CommandEmpty>No images found.</CommandEmpty>
            <CommandGroup>
              {filteredSavedImages.map((savedImage) => (
                <CommandCheckboxItem
                  key={savedImage.id}
                  onSelect={() => handleSelect(savedImage.name)}
                  value={savedImage.name}
                  className="cursor-pointer items-start"
                  checked={value.includes(savedImage.name)}
                >
                  <div className="min-w-0 space-y-0.5">
                    <div className="truncate text-sm">
                      {savedImage.displayName || getSavedImageDisplayName(savedImage.name)}
                    </div>
                    <div className="truncate text-xs text-muted-foreground">{savedImage.name}</div>
                  </div>
                </CommandCheckboxItem>
              ))}
            </CommandGroup>
          </>
        )}
      </CommandList>
    </Command>
  )
}
