/*
 * Copyright 2025 Daytona Platforms Inc.
 * Modified by BoxLite AI, 2025-2026
 * SPDX-License-Identifier: AGPL-3.0
 */

import PythonIcon from '@/assets/python.svg'
import TypescriptIcon from '@/assets/typescript.svg'
import CodeBlock from '@/components/CodeBlock'
import { CopyButton } from '@/components/CopyButton'
import TooltipButton from '@/components/TooltipButton'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  FileSystemActions,
  GitOperationsActions,
  ProcessCodeExecutionActions,
  BoxParametersSections,
} from '@/enums/Playground'
import { usePlayground } from '@/hooks/usePlayground'
import { usePlaygroundBox } from '@/hooks/usePlaygroundBox'
import { createErrorMessageOutput, getLanguageCodeToRun } from '@/lib/playground'
import { cn } from '@/lib/utils'
import { CodeLanguage, Box } from '@boxlite-ai/sdk'
import { ChevronUpIcon, Loader2, PanelBottom, Play, XIcon } from 'lucide-react'
import { ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Group, Panel, usePanelRef } from 'react-resizable-panels'
import ResponseCard from '../ResponseCard'
import { Window, WindowContent, WindowTitleBar } from '../Window'
import { codeSnippetGenerators, CodeSnippetParams } from './CodeSnippets'

const codeSnippetSupportedLanguages = [
  { value: CodeLanguage.PYTHON, label: 'Python', icon: PythonIcon },
  { value: CodeLanguage.TYPESCRIPT, label: 'TypeScript', icon: TypescriptIcon },
] as const

const SECTION_SCROLL_MARKERS: Partial<Record<BoxParametersSections, string[]>> = {
  [BoxParametersSections.FILE_SYSTEM]: [
    '# Create folder',
    '# List files',
    '# Delete',
    '// Create folder',
    '// List files',
    '// Delete',
  ],
  [BoxParametersSections.GIT_OPERATIONS]: [
    '# Clone git',
    '# Get repository',
    '# List branches',
    '// Clone git',
    '// Get repository',
    '// List branches',
  ],
  [BoxParametersSections.PROCESS_CODE_EXECUTION]: [
    '# Run code securely',
    '# Execute shell',
    '// Run code securely',
    '// Execute shell',
  ],
}

const BoxCodeSnippetsResponse = ({ className }: { className?: string }) => {
  const [codeSnippetLanguage, setCodeSnippetLanguage] = useState<CodeLanguage>(CodeLanguage.PYTHON)
  const [codeSnippetOutput, setCodeSnippetOutput] = useState<string | ReactNode>('')
  const [isCodeSnippetRunning, setIsCodeSnippetRunning] = useState<boolean>(false)

  const {
    boxParametersState,
    actionRuntimeError,
    getBoxParametersInfo,
    enabledSections,
    pendingScrollSection,
    clearPendingScrollSection,
  } = usePlayground()
  const {
    box: { create: createBox },
  } = usePlaygroundBox()

  const useConfigObject = false // Currently not needed, we use jwtToken for client config

  const fsOn = enabledSections.includes(BoxParametersSections.FILE_SYSTEM)
  const gitOn = enabledSections.includes(BoxParametersSections.GIT_OPERATIONS)
  const procOn = enabledSections.includes(BoxParametersSections.PROCESS_CODE_EXECUTION)

  const fileSystemListFilesLocationSet = fsOn && !actionRuntimeError[FileSystemActions.LIST_FILES]
  const fileSystemCreateFolderParamsSet = fsOn && !actionRuntimeError[FileSystemActions.CREATE_FOLDER]
  const fileSystemDeleteFileRequiredParamsSet = fsOn && !actionRuntimeError[FileSystemActions.DELETE_FILE]
  const useFileSystemDeleteFileRecursive =
    fileSystemDeleteFileRequiredParamsSet && boxParametersState['deleteFileParams'].recursive === true
  const shellCommandExists = procOn && !actionRuntimeError[ProcessCodeExecutionActions.SHELL_COMMANDS_RUN]
  const codeToRunExists = procOn && !actionRuntimeError[ProcessCodeExecutionActions.CODE_RUN]
  const gitCloneOperationRequiredParamsSet = gitOn && !actionRuntimeError[GitOperationsActions.GIT_CLONE]
  const useGitCloneBranch = !!boxParametersState['gitCloneParams'].branchToClone
  const useGitCloneCommitId = !!boxParametersState['gitCloneParams'].commitToClone
  const useGitCloneUsername = !!boxParametersState['gitCloneParams'].authUsername
  const useGitClonePassword = !!boxParametersState['gitCloneParams'].authPassword
  const gitStatusOperationLocationSet = gitOn && !actionRuntimeError[GitOperationsActions.GIT_STATUS]
  const gitBranchesOperationLocationSet = gitOn && !actionRuntimeError[GitOperationsActions.GIT_BRANCHES_LIST]

  const codeScrollRef = useRef<HTMLDivElement>(null)
  const highlightTimersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const scrollToSection = useCallback((section: BoxParametersSections) => {
    const viewport = codeScrollRef.current?.querySelector<HTMLElement>('[data-slot=scroll-area-viewport]')
    if (!viewport) return

    const markers = SECTION_SCROLL_MARKERS[section]
    if (!markers?.length) return

    const walker = document.createTreeWalker(viewport, NodeFilter.SHOW_TEXT)
    let node: Text | null
    while ((node = walker.nextNode() as Text | null)) {
      const text = node.textContent?.trim() ?? ''
      if (!markers.some((m) => text.startsWith(m))) continue

      const span = node.parentElement
      if (!span) continue

      const el = (span.closest('[class*="line"]') as HTMLElement | null) ?? span
      const viewportRect = viewport.getBoundingClientRect()
      viewport.scrollTo({
        top: viewport.scrollTop + el.getBoundingClientRect().top - viewportRect.top - 32,
        behavior: 'smooth',
      })

      highlightTimersRef.current.forEach(clearTimeout)
      el.style.backgroundColor = 'rgba(34, 197, 94, 0.2)'
      el.style.borderRadius = '3px'
      highlightTimersRef.current = [
        setTimeout(() => {
          el.style.transition = 'background-color 1.5s ease-out'
          el.style.backgroundColor = 'rgba(34, 197, 94, 0)'
        }, 500),
        setTimeout(() => {
          el.style.backgroundColor = ''
          el.style.transition = ''
          el.style.borderRadius = ''
        }, 2100),
      ]
      return
    }
  }, [])

  useEffect(() => {
    if (!pendingScrollSection) return
    requestAnimationFrame(() => {
      scrollToSection(pendingScrollSection)
      clearPendingScrollSection()
    })
  }, [pendingScrollSection, scrollToSection, clearPendingScrollSection])

  const createCodeSnippetParams = useCallback(
    (codeSnippetLanguage: CodeLanguage): CodeSnippetParams => ({
      state: boxParametersState,
      config: getBoxParametersInfo(),
      actions: {
        codeSnippetLanguage,
        useConfigObject,
        fileSystemListFilesLocationSet,
        fileSystemCreateFolderParamsSet,
        fileSystemDeleteFileRequiredParamsSet,
        useFileSystemDeleteFileRecursive,
        shellCommandExists,
        codeToRunExists,
        gitCloneOperationRequiredParamsSet,
        useGitCloneBranch,
        useGitCloneCommitId,
        useGitCloneUsername,
        useGitClonePassword,
        gitStatusOperationLocationSet,
        gitBranchesOperationLocationSet,
      },
    }),
    [
      boxParametersState,
      getBoxParametersInfo,
      useConfigObject,
      fileSystemListFilesLocationSet,
      fileSystemCreateFolderParamsSet,
      fileSystemDeleteFileRequiredParamsSet,
      useFileSystemDeleteFileRecursive,
      shellCommandExists,
      codeToRunExists,
      gitCloneOperationRequiredParamsSet,
      useGitCloneBranch,
      useGitCloneCommitId,
      useGitCloneUsername,
      useGitClonePassword,
      gitStatusOperationLocationSet,
      gitBranchesOperationLocationSet,
    ],
  )

  const boxCodeSnippetsData = useMemo(
    () => ({
      [CodeLanguage.PYTHON]: {
        code: codeSnippetGenerators[CodeLanguage.PYTHON].buildFullSnippet(createCodeSnippetParams(CodeLanguage.PYTHON)),
      },
      [CodeLanguage.TYPESCRIPT]: {
        code: codeSnippetGenerators[CodeLanguage.TYPESCRIPT].buildFullSnippet(
          createCodeSnippetParams(CodeLanguage.TYPESCRIPT),
        ),
      },
    }),
    [createCodeSnippetParams],
  )

  const runCodeSnippet = async () => {
    setIsCodeSnippetRunning(true)
    let codeSnippetOutput = 'Creating box...\n'
    setCodeSnippetOutput(codeSnippetOutput)
    let box: Box | undefined

    try {
      box = await createBox()
      codeSnippetOutput = `Box successfully created: ${box.id}\n`
      setCodeSnippetOutput(codeSnippetOutput)
      if (codeToRunExists) {
        setCodeSnippetOutput(codeSnippetOutput + '\nRunning code...')
        const codeRunResponse = await box.process.codeRun(getLanguageCodeToRun(codeSnippetLanguage))
        codeSnippetOutput += `\nCode run result: ${codeRunResponse.result}`
        setCodeSnippetOutput(codeSnippetOutput)
      }
      if (shellCommandExists) {
        setCodeSnippetOutput(codeSnippetOutput + '\nRunning shell command...')
        const shellCommandResponse = await box.process.executeCommand(
          boxParametersState['shellCommandRunParams'].shellCommand as string, // shellCommandExists guarantees that value isn't undefined so we put as string to silence TS compiler
        )
        codeSnippetOutput += `\nShell command result: ${shellCommandResponse.result}`
        setCodeSnippetOutput(codeSnippetOutput)
      }
      let codeRunShellCommandFinishedMessage = '\n'
      if (codeToRunExists && shellCommandExists) {
        codeRunShellCommandFinishedMessage += '🎉 Code and shell command executed successfully.'
      } else if (codeToRunExists) {
        codeRunShellCommandFinishedMessage += '🎉 Code executed successfully.'
      } else if (shellCommandExists) {
        codeRunShellCommandFinishedMessage += '🎉 Shell command executed successfully.'
      }
      codeSnippetOutput += codeRunShellCommandFinishedMessage + '\n'
      setCodeSnippetOutput(codeSnippetOutput)
      if (fileSystemCreateFolderParamsSet) {
        setCodeSnippetOutput(codeSnippetOutput + '\nCreating directory...')
        await box.fs.createFolder(
          boxParametersState['createFolderParams'].folderDestinationPath,
          boxParametersState['createFolderParams'].permissions,
        )
        codeSnippetOutput += '\n🎉 Directory created successfully.\n'
        setCodeSnippetOutput(codeSnippetOutput)
      }
      if (fileSystemListFilesLocationSet) {
        setCodeSnippetOutput(codeSnippetOutput + '\nListing directory files...')
        const files = await box.fs.listFiles(boxParametersState['listFilesParams'].directoryPath)
        codeSnippetOutput += '\nDirectory content:'
        codeSnippetOutput += '\n'
        files.forEach((file) => {
          codeSnippetOutput += `Name: ${file.name}\n`
          codeSnippetOutput += `Is directory: ${file.isDir}\n`
          codeSnippetOutput += `Size: ${file.size}\n`
          codeSnippetOutput += `Modified: ${file.modTime}\n`
        })
        setCodeSnippetOutput(codeSnippetOutput)
      }
      if (fileSystemDeleteFileRequiredParamsSet) {
        setCodeSnippetOutput(
          codeSnippetOutput + `\nDeleting ${useFileSystemDeleteFileRecursive ? 'directory' : 'file'}...`,
        )
        await box.fs.deleteFile(
          boxParametersState['deleteFileParams'].filePath,
          useFileSystemDeleteFileRecursive || false,
        )
        codeSnippetOutput += `\n🎉 ${useFileSystemDeleteFileRecursive ? 'Directory' : 'File'} deleted successfully.\n`
        setCodeSnippetOutput(codeSnippetOutput)
      }
      if (gitCloneOperationRequiredParamsSet) {
        setCodeSnippetOutput(codeSnippetOutput + '\nCloning repo...')
        await box.git.clone(
          boxParametersState['gitCloneParams'].repositoryURL,
          boxParametersState['gitCloneParams'].cloneDestinationPath,
          useGitCloneBranch ? boxParametersState['gitCloneParams'].branchToClone : undefined,
          useGitCloneCommitId ? boxParametersState['gitCloneParams'].commitToClone : undefined,
          useGitCloneUsername ? boxParametersState['gitCloneParams'].authUsername : undefined,
          useGitClonePassword ? boxParametersState['gitCloneParams'].authPassword : undefined,
        )
        codeSnippetOutput += '\n🎉 Repository cloned successfully.\n'
        setCodeSnippetOutput(codeSnippetOutput)
      }
      if (gitStatusOperationLocationSet) {
        setCodeSnippetOutput(codeSnippetOutput + '\nFetching repository status...')
        const status = await box.git.status(boxParametersState['gitStatusParams'].repositoryPath)
        codeSnippetOutput += `\nCurrent branch: ${status.currentBranch}\n`
        codeSnippetOutput += `Commits ahead: ${status.ahead}\n`
        codeSnippetOutput += `Commits behind: ${status.behind}\n`
        status.fileStatus.forEach((file) => (codeSnippetOutput += `File: ${file.name}\n`))
        setCodeSnippetOutput(codeSnippetOutput)
      }
      if (gitBranchesOperationLocationSet) {
        setCodeSnippetOutput(codeSnippetOutput + '\nFetching repository branches...')
        const response = await box.git.branches(boxParametersState['gitBranchesParams'].repositoryPath)
        codeSnippetOutput += '\n'
        response.branches.forEach((branch) => (codeSnippetOutput += `Branch: ${branch}\n`))
        setCodeSnippetOutput(codeSnippetOutput)
      }
      setCodeSnippetOutput(codeSnippetOutput + '\nBox session finished.')
    } catch (error) {
      console.error(error)
      setCodeSnippetOutput(
        <>
          <span>{codeSnippetOutput}</span>
          <br />
          {createErrorMessageOutput(error)}
        </>,
      )
    } finally {
      setIsCodeSnippetRunning(false)
    }
  }

  const resultPanelRef = usePanelRef()

  return (
    <Window className={className}>
      <WindowTitleBar>Box Code</WindowTitleBar>
      <WindowContent className="relative">
        <Tabs
          value={codeSnippetLanguage}
          className="flex flex-col gap-4"
          onValueChange={(languageValue) => setCodeSnippetLanguage(languageValue as CodeLanguage)}
        >
          <div className="flex justify-between items-center">
            <TabsList>
              {codeSnippetSupportedLanguages.map((language) => (
                <TabsTrigger
                  key={language.value}
                  value={language.value}
                  className={cn('py-1 rounded-t-md', {
                    'bg-foreground/10': codeSnippetLanguage === language.value,
                  })}
                >
                  <div className="flex items-center text-sm">
                    <img src={language.icon} alt={`${language.label} icon`} className="w-4 h-4" />
                    <span className="ml-2">{language.label}</span>
                  </div>
                </TabsTrigger>
              ))}
            </TabsList>
            <div className="flex items-center gap-2">
              <Button
                disabled={isCodeSnippetRunning}
                variant="outline"
                className="ml-auto"
                onClick={() => {
                  runCodeSnippet()
                  if (resultPanelRef.current?.isCollapsed()) {
                    resultPanelRef.current.resize(100)
                  }
                }}
              >
                {isCodeSnippetRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="w-4 h-4" />} Run
              </Button>
              <TooltipButton
                tooltipText="Show result"
                className="!px-2"
                size="icon-sm"
                variant="outline"
                onClick={() => {
                  if (resultPanelRef.current?.isCollapsed()) {
                    resultPanelRef.current.resize('20%')
                  } else {
                    resultPanelRef.current?.collapse()
                  }
                }}
              >
                <PanelBottom />
              </TooltipButton>
            </div>
          </div>
          <Group orientation="vertical" className="min-h-[500px] border-border rounded-b-md">
            <Panel minSize={'20%'}>
              <div ref={codeScrollRef} className="h-full">
                {codeSnippetSupportedLanguages.map((language) => (
                  <TabsContent
                    key={language.value}
                    value={language.value}
                    className="rounded-md h-full overflow-auto mt-0"
                  >
                    <CopyButton
                      className="absolute right-4 z-10 backdrop-blur-sm"
                      variant="ghost"
                      size="icon-sm"
                      value={boxCodeSnippetsData[language.value].code}
                    />
                    <ScrollArea
                      fade="mask"
                      horizontal
                      className="h-full overflow-auto bg-[hsl(var(--code-background))]"
                      fadeOffset={35}
                    >
                      <CodeBlock
                        showCopy={false}
                        language={language.value}
                        code={boxCodeSnippetsData[language.value].code}
                        codeAreaClassName="text-sm [overflow:initial] min-w-fit h-full"
                      />
                    </ScrollArea>
                  </TabsContent>
                ))}
              </div>
            </Panel>

            <Panel maxSize="80%" minSize="20%" panelRef={resultPanelRef} collapsedSize={0} collapsible defaultSize={33}>
              <div className="bg-background w-full border rounded-md overflow-auto h-full flex flex-col">
                <div className="flex justify-between border-b px-4 pr-2 py-1 text-xs items-center bg-muted/50">
                  <div className="text-muted-foreground font-mono">Result</div>
                  <div className="flex items-center gap-2">
                    <TooltipButton
                      onClick={() => resultPanelRef.current?.resize('80%')}
                      tooltipText="Maximize"
                      className="h-6 w-6"
                      size="sm"
                      variant="ghost"
                    >
                      <ChevronUpIcon className="w-4 h-4" />
                    </TooltipButton>
                    <TooltipButton
                      tooltipText="Close"
                      className="h-6 w-6"
                      size="sm"
                      variant="ghost"
                      onClick={() => resultPanelRef.current?.collapse()}
                    >
                      <XIcon />
                    </TooltipButton>
                  </div>
                </div>
                <div className="flex-1 overflow-y-auto">
                  <ResponseCard
                    responseContent={
                      codeSnippetOutput || (
                        <div className="text-muted-foreground font-mono">Code output will be shown here...</div>
                      )
                    }
                  />
                </div>
              </div>
            </Panel>
          </Group>
        </Tabs>
      </WindowContent>
    </Window>
  )
}

export default BoxCodeSnippetsResponse
