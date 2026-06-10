/*
 * Copyright Daytona Platforms Inc.
 * SPDX-License-Identifier: AGPL-3.0
 */

import { CodeSnippetGenerator } from './types'
import { joinGroupedSections } from './utils'
import { getLanguageCodeToRun } from '@/lib/playground'

export const PythonSnippetGenerator: CodeSnippetGenerator = {
  getImports(p) {
    return (
      [
        'from boxlite import BoxLite as BoxLite',
        p.actions.useConfigObject ? 'BoxliteConfig as BoxLiteConfig' : '',
        p.config.useBoxCreateParams
          ? p.config.createBoxFromTemplate
            ? 'CreateBoxFromTemplateParams as CreateBoxFromImageParams'
            : 'CreateBoxFromImageParams as CreateBoxFromImageParams'
          : '',
        p.config.useResources ? 'Resources' : '',
        p.config.createBoxFromImage ? 'Image' : '',
      ]
        .filter(Boolean)
        .join(', ') + '\n'
    )
  },

  getConfig(p) {
    if (!p.actions.useConfigObject) return ''
    return ['\n# Define the configuration', 'config = BoxLiteConfig()'].filter(Boolean).join('\n') + '\n'
  },

  getClientInit(p) {
    return ['# Initialize the BoxLite client', `boxlite = BoxLite(${p.actions.useConfigObject ? 'config' : ''})`]
      .filter(Boolean)
      .join('\n')
  },

  getResources(p) {
    if (!p.config.useResources) return ''
    const ind = '\t'
    return [
      '\n\n# Create a Box with custom resources\nresources = Resources(',
      p.config.useResourcesCPU
        ? `${ind}cpu=${p.state['resources']['cpu']}, # ${p.state['resources']['cpu']} CPU cores`
        : '',
      p.config.useResourcesMemory
        ? `${ind}memory=${p.state['resources']['memory']}, # ${p.state['resources']['memory']}GB RAM`
        : '',
      p.config.useResourcesDisk
        ? `${ind}disk=${p.state['resources']['disk']}, # ${p.state['resources']['disk']}GB disk space`
        : '',
      ')',
    ]
      .filter(Boolean)
      .join('\n')
  },

  getBoxParams(p) {
    if (!p.config.useBoxCreateParams) return ''
    const ind = '\t'
    return [
      `\n\nparams = CreateBoxFromImageParams(`,
      p.config.createBoxFromImage ? `${ind}image=Image.debian_slim("3.13"),` : '',
      p.config.useResources ? `${ind}resources=resources,` : '',
      p.config.useLanguageParam ? `${ind}language="${p.state['language']}",` : '',
      ...(p.config.createBoxParamsExist
        ? [
            p.config.useAutoStopInterval
              ? `${ind}auto_stop_interval=${p.state['createBoxBaseParams']['autoStopInterval']}, # ${p.state['createBoxBaseParams']['autoStopInterval'] == 0 ? 'Disables the auto-stop feature' : `Box will be stopped after ${p.state['createBoxBaseParams']['autoStopInterval']} minute${(p.state['createBoxBaseParams']['autoStopInterval'] as number) > 1 ? 's' : ''}`}`
              : '',
            p.config.useAutoDeleteInterval
              ? `${ind}auto_delete_interval=${p.state['createBoxBaseParams']['autoDeleteInterval']}, # ${p.state['createBoxBaseParams']['autoDeleteInterval'] == 0 ? 'Box will be deleted immediately after stopping' : p.state['createBoxBaseParams']['autoDeleteInterval'] == -1 ? 'Auto-delete functionality disabled' : `Auto-delete after a Box has been stopped for ${p.state['createBoxBaseParams']['autoDeleteInterval']} minutes`}`
              : '',
          ]
        : []),
      ')',
    ]
      .filter(Boolean)
      .join('\n')
  },

  getBoxCreate(p) {
    return [
      '\n# Create the Box instance',
      `box = boxlite.create(${p.config.useBoxCreateParams ? 'params' : ''})`,
      'print(f"Box created:{box.id}")',
    ].join('\n')
  },

  getCodeRun(p) {
    if (!p.actions.codeToRunExists) return ''
    const ind = '\t'
    return [
      '\n\n# Run code securely inside the Box',
      'codeRunResponse = box.process.code_run(',
      `'''${getLanguageCodeToRun(p.actions.codeSnippetLanguage)}'''`,
      ')',
      'if codeRunResponse.exit_code != 0:',
      `${ind}print(f"Error: {codeRunResponse.exit_code} {codeRunResponse.result}")`,
      'else:',
      `${ind}print(codeRunResponse.result)`,
    ].join('\n')
  },

  getShellRun(p) {
    if (!p.actions.shellCommandExists) return ''
    return [
      '\n\n# Execute shell commands',
      `shellRunResponse = box.process.exec("${p.state['shellCommandRunParams'].shellCommand}")`,
      'print(shellRunResponse.result)',
    ].join('\n')
  },

  getFileSystemOps(p) {
    const sections: string[] = []
    const ind = '\t'

    if (p.actions.fileSystemCreateFolderParamsSet) {
      sections.push(
        [
          '# Create folder with specific permissions',
          `box.fs.create_folder("${p.state['createFolderParams'].folderDestinationPath}", "${p.state['createFolderParams'].permissions}")`,
        ].join('\n'),
      )
    }

    if (p.actions.fileSystemListFilesLocationSet) {
      sections.push(
        [
          '# List files in a directory',
          `files = box.fs.list_files("${p.state['listFilesParams'].directoryPath}")`,
          'for file in files:',
          `${ind}print(f"Name: {file.name}")`,
          `${ind}print(f"Is directory: {file.is_dir}")`,
          `${ind}print(f"Size: {file.size}")`,
          `${ind}print(f"Modified: {file.mod_time}")`,
        ].join('\n'),
      )
    }

    if (p.actions.fileSystemDeleteFileRequiredParamsSet) {
      sections.push(
        [
          `# Delete ${p.actions.useFileSystemDeleteFileRecursive ? 'directory' : 'file'}`,
          `box.fs.delete_file("${p.state['deleteFileParams'].filePath}"${p.actions.useFileSystemDeleteFileRecursive ? ', True' : ''})`,
        ].join('\n'),
      )
    }

    return joinGroupedSections(sections)
  },

  getGitOps(p) {
    const sections: string[] = []
    const ind = '\t'

    if (p.actions.gitCloneOperationRequiredParamsSet) {
      sections.push(
        [
          '# Clone git repository',
          'box.git.clone(',
          `${ind}url="${p.state['gitCloneParams'].repositoryURL}",`,
          `${ind}path="${p.state['gitCloneParams'].cloneDestinationPath}",`,
          p.actions.useGitCloneBranch ? `${ind}branch="${p.state['gitCloneParams'].branchToClone}",` : '',
          p.actions.useGitCloneCommitId ? `${ind}commit_id="${p.state['gitCloneParams'].commitToClone}",` : '',
          p.actions.useGitCloneUsername ? `${ind}username="${p.state['gitCloneParams'].authUsername}",` : '',
          p.actions.useGitClonePassword ? `${ind}password="${p.state['gitCloneParams'].authPassword}"` : '',
          ')',
        ]
          .filter(Boolean)
          .join('\n'),
      )
    }

    if (p.actions.gitStatusOperationLocationSet) {
      sections.push(
        [
          '# Get repository status',
          `status = box.git.status("${p.state['gitStatusParams'].repositoryPath}")`,
          'print(f"Current branch: {status.current_branch}")',
          'print(f"Commits ahead: {status.ahead}")',
          'print(f"Commits behind: {status.behind}")',
          'for file_status in status.file_status:',
          '\tprint(f"File: {file_status.name}")',
        ].join('\n'),
      )
    }

    if (p.actions.gitBranchesOperationLocationSet) {
      sections.push(
        [
          '# List branches',
          `branchesResponse = box.git.branches("${p.state['gitBranchesParams'].repositoryPath}")`,
          'for branch in branchesResponse.branches:',
          '\tprint(f"Branch: {branch}")',
        ].join('\n'),
      )
    }

    return joinGroupedSections(sections)
  },

  buildFullSnippet(p) {
    const imports = this.getImports(p)
    const config = this.getConfig(p)
    const client = this.getClientInit(p)
    const resources = this.getResources(p)
    const params = this.getBoxParams(p)
    const create = this.getBoxCreate(p)
    const codeRun = this.getCodeRun(p)
    const shell = this.getShellRun(p)
    const fsOps = this.getFileSystemOps(p)
    const gitOps = this.getGitOps(p)

    return `${imports}${config}\n${client}${resources}${params}\n${create}${fsOps}${gitOps}${codeRun}${shell}`
  },
}
