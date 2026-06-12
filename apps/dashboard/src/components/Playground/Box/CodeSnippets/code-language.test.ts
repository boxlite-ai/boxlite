import { CodeLanguage } from '@boxlite-ai/sdk'
import { describe, expect, it } from 'vitest'
import { getLanguageCodeToRun } from '@/lib/playground'
import { TypeScriptSnippetGenerator } from './typescript'
import { CodeSnippetParams } from './types'

function baseParams(codeSnippetLanguage: CodeLanguage): CodeSnippetParams {
  return {
    state: {
      resources: { cpu: 1, memory: 1, disk: 3 },
      createBoxBaseParams: {},
      listFilesParams: { directoryPath: 'workspace' },
      createFolderParams: { folderDestinationPath: 'workspace/new-dir', permissions: '755' },
      deleteFileParams: { filePath: 'workspace/new-dir', recursive: true },
      gitCloneParams: { repositoryURL: '', cloneDestinationPath: '' },
      gitStatusParams: { repositoryPath: '' },
      gitBranchesParams: { repositoryPath: '' },
      codeRunParams: {
        languageCode: getLanguageCodeToRun(CodeLanguage.PYTHON),
      },
      shellCommandRunParams: {},
    },
    config: {
      useResources: false,
      useResourcesCPU: false,
      useResourcesMemory: false,
      useResourcesDisk: false,
      useBoxCreateParams: false,
      createBoxFromImage: false,
      createBoxFromTemplate: false,
      useCustomImageName: false,
      useLanguageParam: false,
      createBoxParamsExist: false,
      useAutoStopInterval: false,
      useAutoDeleteInterval: false,
      createBoxParams: {},
    },
    actions: {
      codeSnippetLanguage,
      useConfigObject: false,
      fileSystemListFilesLocationSet: false,
      fileSystemCreateFolderParamsSet: false,
      fileSystemDeleteFileRequiredParamsSet: false,
      useFileSystemDeleteFileRecursive: false,
      shellCommandExists: false,
      codeToRunExists: true,
      gitCloneOperationRequiredParamsSet: false,
      useGitCloneBranch: false,
      useGitCloneCommitId: false,
      useGitCloneUsername: false,
      useGitClonePassword: false,
      gitStatusOperationLocationSet: false,
      gitBranchesOperationLocationSet: false,
    },
  }
}

describe('playground code snippet language', () => {
  it('uses TypeScript executed code in the TypeScript SDK snippet', () => {
    const code = TypeScriptSnippetGenerator.buildFullSnippet(baseParams(CodeLanguage.TYPESCRIPT))

    expect(code).toContain('function greet(name: string): string')
    expect(code).not.toContain('def greet(name):')
  })
})
