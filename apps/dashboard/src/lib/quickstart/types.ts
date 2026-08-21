export type QuickstartIconName = 'python' | 'typescript' | 'go' | 'rust' | 'terminal' | 'server' | 'file'

export type QuickstartGroup = 'sdk' | 'direct'

export interface QuickstartInterfaceDefinition {
  id: string
  label: string
  /** Which picker group the entry belongs to — 'sdk' is a language library, 'direct' talks to the API without one. */
  group: QuickstartGroup
  icon: QuickstartIconName
  install: string
  run: string
  codeLanguage: string
  setupLabel?: string
  setupDescription?: string
  executionDescription: string
  template: string
}

export interface OnboardingCodeExample extends QuickstartInterfaceDefinition {
  example: string
}

export interface RenderOnboardingCodeExampleOptions {
  apiKey?: string
  restApiUrl: string
}
