export type QuickstartIconName = 'python' | 'typescript' | 'go' | 'rust' | 'terminal' | 'server' | 'badge'

export interface QuickstartInterfaceDefinition {
  id: string
  label: string
  ariaLabel?: string
  icon: QuickstartIconName
  badge?: string
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
