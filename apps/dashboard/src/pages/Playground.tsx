/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { PageContent, PageHeader, PageLayout, PageTitle } from '@/components/PageLayout'
import {
  PlaygroundLayout,
  PlaygroundLayoutContent,
  PlaygroundLayoutSidebar,
} from '@/components/Playground/PlaygroundLayout'
import BoxCodeSnippetsResponse from '@/components/Playground/Box/CodeSnippetsResponse'
import BoxParameters from '@/components/Playground/Box/Parameters'
import TerminalDescription from '@/components/Playground/Terminal/Description'
import WebTerminal from '@/components/Playground/Terminal/WebTerminal'
import VNCDesktopWindowResponse from '@/components/Playground/VNC/DesktopWindowResponse'
import VNCInteractionOptions from '@/components/Playground/VNC/Interaction'
import { Button } from '@/components/ui/button'
import { Drawer, DrawerContent } from '@/components/ui/drawer'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { FeatureFlags } from '@/enums/FeatureFlags'
import { PlaygroundCategories } from '@/enums/Playground'
import { isDashboardVncEnabled } from '@/lib/dashboard-features'
import { PlaygroundProvider } from '@/providers/PlaygroundProvider'
import { PlaygroundBoxProvider } from '@/providers/PlaygroundBoxProvider'
import { AnimatePresence, motion } from 'framer-motion'
import { SettingsIcon } from 'lucide-react'
import { useFeatureFlagEnabled } from 'posthog-js/react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useResizeObserver } from 'usehooks-ts'

const playgroundCategoriesData = [
  { value: PlaygroundCategories.BOX, label: 'Box' },
  { value: PlaygroundCategories.TERMINAL, label: 'Terminal' },
  { value: PlaygroundCategories.VNC, label: 'VNC' },
]

const SlideLeftRight = ({ children, direction }: { children: React.ReactNode; direction: 'left' | 'right' }) => {
  return (
    <motion.div
      initial={{ opacity: 0, filter: 'blur(2px)', x: direction === 'left' ? -20 : 20 }}
      animate={{ opacity: 1, filter: 'blur(0px)', x: 0 }}
      exit={{ opacity: 0, filter: 'blur(2px)', x: direction === 'left' ? 20 : -20 }}
      transition={{ duration: 0.2 }}
    >
      {children}
    </motion.div>
  )
}

const Playground: React.FC = () => {
  const vncEnabled = isDashboardVncEnabled(useFeatureFlagEnabled(FeatureFlags.DASHBOARD_VNC))
  const [playgroundCategory, setPlaygroundCategory] = useState<PlaygroundCategories>(PlaygroundCategories.BOX)
  const availableCategories = useMemo(
    () => playgroundCategoriesData.filter((category) => vncEnabled || category.value !== PlaygroundCategories.VNC),
    [vncEnabled],
  )

  const [drawerOpen, setDrawerOpen] = useState<PlaygroundCategories | null>(null)
  const handleDrawerOpenChange = (open: boolean) => {
    if (!open) {
      setDrawerOpen(null)
    }
  }

  const pageContentRef = useRef<HTMLDivElement>(null)

  useResizeObserver({
    ref: pageContentRef as React.RefObject<HTMLElement>,
    onResize: () => {
      if (pageContentRef.current) {
        const { width } = pageContentRef.current.getBoundingClientRect()
        if (width < 1024) {
          setDrawerOpen(null)
        }
      }
    },
  })

  const prevCategory = useRef<PlaygroundCategories>(playgroundCategory)
  useEffect(() => {
    prevCategory.current = playgroundCategory
  }, [playgroundCategory])

  useEffect(() => {
    if (!vncEnabled && playgroundCategory === PlaygroundCategories.VNC) {
      setPlaygroundCategory(PlaygroundCategories.BOX)
      setDrawerOpen(null)
    }
  }, [playgroundCategory, vncEnabled])

  const direction = useMemo(() => {
    const currentIndex = availableCategories.findIndex((category) => category.value === playgroundCategory)
    const prevIndex = availableCategories.findIndex((category) => category.value === prevCategory.current)
    return currentIndex > prevIndex ? 'right' : 'left'
  }, [availableCategories, playgroundCategory])

  const sidePanel = useMemo(() => {
    if (playgroundCategory === PlaygroundCategories.BOX) return <BoxParameters />
    if (playgroundCategory === PlaygroundCategories.TERMINAL) return <TerminalDescription />
    if (playgroundCategory === PlaygroundCategories.VNC) return <VNCInteractionOptions />
    return null
  }, [playgroundCategory])

  return (
    <PageLayout className="max-h-[100vh] overflow-auto">
      <PageHeader size="full">
        <PageTitle>Playground</PageTitle>
      </PageHeader>

      <PageContent size="full" className="!p-0 h-full flex flex-col flex-1 overflow-auto" ref={pageContentRef}>
        <PlaygroundProvider>
          <PlaygroundBoxProvider activeTab={playgroundCategory} vncEnabled={vncEnabled}>
            <Tabs
              value={playgroundCategory}
              onValueChange={(value) => setPlaygroundCategory(value as PlaygroundCategories)}
              className="h-full gap-0"
            >
              <div className="flex items-center justify-between shadow-[inset_0_-1px] shadow-border pr-4">
                <TabsList className="px-2 shadow-none bg-transparent w-auto pb-0">
                  {availableCategories.map((category) => (
                    <TabsTrigger
                      value={category.value}
                      key={category.value}
                      className="data-[state=inactive]:border-b-transparent data-[state=active]:border-b-foreground border-b rounded-none !shadow-none -mb-0.5 pb-1.5"
                    >
                      {category.label}
                    </TabsTrigger>
                  ))}
                </TabsList>
                <Button
                  onClick={() => setDrawerOpen(playgroundCategory)}
                  variant="ghost"
                  size="sm"
                  className="lg:hidden"
                >
                  <SettingsIcon className="size-4 mr-2" /> Configure
                </Button>
              </div>
              <TabsContent
                value={playgroundCategory}
                key={playgroundCategory}
                className="mt-0 data-[state=inactive]:hidden"
                asChild
              >
                <PlaygroundLayout className="overflow-auto">
                  <PlaygroundLayoutSidebar>
                    <AnimatePresence mode="popLayout">
                      <SlideLeftRight direction={direction} key={playgroundCategory}>
                        {sidePanel}
                      </SlideLeftRight>
                    </AnimatePresence>
                  </PlaygroundLayoutSidebar>

                  <Drawer open={drawerOpen === playgroundCategory} onOpenChange={handleDrawerOpenChange}>
                    <DrawerContent>
                      <div className="p-4 overflow-auto">{sidePanel}</div>
                    </DrawerContent>
                  </Drawer>
                  <PlaygroundLayoutContent className="[&>*]:w-full [&>*]:max-w-[min(90%,1024px)]">
                    {playgroundCategory === PlaygroundCategories.BOX && <BoxCodeSnippetsResponse />}
                    {playgroundCategory === PlaygroundCategories.TERMINAL && <WebTerminal />}
                    {playgroundCategory === PlaygroundCategories.VNC && <VNCDesktopWindowResponse />}
                  </PlaygroundLayoutContent>
                </PlaygroundLayout>
              </TabsContent>
            </Tabs>
          </PlaygroundBoxProvider>
        </PlaygroundProvider>
      </PageContent>
    </PageLayout>
  )
}

export default Playground
