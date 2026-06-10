export function getCreatedApiKeyCopyButtonLabel({ copiedText, apiKey }: { copiedText: string | null; apiKey: string }) {
  return copiedText === apiKey ? 'Copied' : 'Copy API Key'
}
