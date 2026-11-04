/** Static deployment configuration supplied by the platform's typed configuration service. */
export interface Config {
  publicUrl: string
  managementUrl: string
  artifactUrl: string
  sessionSecret: string
  identityPrivateKey: string
  runtimeImages: Record<string, string>
  diskSizeGb: number
  autoStopSeconds: number
  domainsEnabled: boolean
  agentMdPath: string
  cliTgzPath: string
  svBinDir: string
  promptTemplatePath?: string
  chromiumPath?: string
  oauth?: Partial<Record<string, { clientId: string; clientSecret: string }>>
  smtpDevSink?: string
}
