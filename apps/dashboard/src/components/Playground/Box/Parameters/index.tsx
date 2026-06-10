/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import { Accordion, AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion'
import { Switch } from '@/components/ui/switch'
import { BoxParametersSections } from '@/enums/Playground'
import { usePlayground } from '@/hooks/usePlayground'
import { cn } from '@/lib/utils'
import { BoltIcon, FolderIcon, GitBranchIcon, SquareTerminalIcon } from 'lucide-react'
import BoxFileSystem from './FileSystem'
import BoxGitOperations from './GitOperations'
import BoxManagementParameters from './Management'
import BoxProcessCodeExecution from './ProcessCodeExecution'

const boxParametersSectionsData = [
  { value: BoxParametersSections.BOX_MANAGEMENT, label: 'Management' },
  { value: BoxParametersSections.FILE_SYSTEM, label: 'File System' },
  { value: BoxParametersSections.GIT_OPERATIONS, label: 'Git Operations' },
  { value: BoxParametersSections.PROCESS_CODE_EXECUTION, label: 'Process & Code Execution' },
]

const sectionIcons = {
  [BoxParametersSections.BOX_MANAGEMENT]: <BoltIcon strokeWidth={1.5} />,
  [BoxParametersSections.GIT_OPERATIONS]: <GitBranchIcon strokeWidth={1.5} />,
  [BoxParametersSections.FILE_SYSTEM]: <FolderIcon strokeWidth={1.5} />,
  [BoxParametersSections.PROCESS_CODE_EXECUTION]: <SquareTerminalIcon strokeWidth={1.5} />,
}

const BoxParameters = ({ className }: { className?: string }) => {
  const { openedParametersSections, setOpenedParametersSections, enabledSections, enableSection, disableSection } =
    usePlayground()

  // TODO(image-rewrite): template selection in the Playground was removed with the image/template
  // subsystem. Management is rendered with an empty template list; rebuild template fetching here.

  return (
    <div className={cn('flex flex-col gap-6', className)}>
      <div>
        <h2>Box Configuration</h2>
        <p className="text-sm text-muted-foreground mt-1">Manage resources, lifecycle policies, and file systems.</p>
      </div>
      <Accordion
        type="multiple"
        value={openedParametersSections}
        onValueChange={(sections) => setOpenedParametersSections(sections as BoxParametersSections[])}
      >
        {boxParametersSectionsData.map((section) => {
          const isManagement = section.value === BoxParametersSections.BOX_MANAGEMENT
          const isEnabled = enabledSections.includes(section.value as BoxParametersSections)
          const isExpanded = openedParametersSections.includes(section.value as BoxParametersSections)
          return (
            <AccordionItem
              key={section.value}
              value={section.value}
              className="border px-2 last:border-b first:rounded-t-lg last:rounded-b-lg border-t-0 first:border-t"
            >
              <AccordionTrigger
                headerClassName={cn(
                  'font-semibold text-muted-foreground dark:bg-muted/50 bg-muted/80 border-b -mx-2 px-3',
                  {
                    'border-b-border': isExpanded,
                    'border-b-transparent': !isExpanded,
                    'opacity-80': !isEnabled && !isManagement,
                  },
                )}
                className="hover:no-underline hover:text-primary py-3"
                right={
                  !isManagement ? (
                    <Switch
                      checked={isEnabled}
                      onCheckedChange={(checked) =>
                        checked
                          ? enableSection(section.value as BoxParametersSections)
                          : disableSection(section.value as BoxParametersSections)
                      }
                      size="sm"
                      className="ml-3"
                    />
                  ) : undefined
                }
              >
                <div className="flex items-center gap-2 [&_svg]:size-4 text-sm font-medium">
                  {sectionIcons[section.value]} {section.label}
                </div>
              </AccordionTrigger>
              <AccordionContent className="py-3 px-1">
                {isExpanded && (
                  <div className="space-y-4">
                    {section.value === BoxParametersSections.FILE_SYSTEM && <BoxFileSystem />}
                    {section.value === BoxParametersSections.GIT_OPERATIONS && <BoxGitOperations />}
                    {section.value === BoxParametersSections.BOX_MANAGEMENT && (
                      <BoxManagementParameters templatesData={[]} templatesLoading={false} />
                    )}
                    {section.value === BoxParametersSections.PROCESS_CODE_EXECUTION && <BoxProcessCodeExecution />}
                  </div>
                )}
              </AccordionContent>
            </AccordionItem>
          )
        })}
      </Accordion>
    </div>
  )
}

export default BoxParameters
