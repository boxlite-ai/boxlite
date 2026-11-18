import { instanceFor } from 'naming'

/** Adopt a working secret reference, or create a password sealed in state and Secrets Manager. */
export const awsPassword = (name: string, existingRef?: string, jsonField?: string) => {
  if (existingRef) {
    const stored = aws.secretsmanager.getSecretVersionOutput({ secretId: existingRef }).secretString
    const decoded = stored.apply((value: string) => {
      try {
        const parsed: unknown = JSON.parse(value)
        if (parsed && typeof parsed === 'object' && jsonField) {
          const password = (parsed as Record<string, unknown>)[jsonField]
          if (typeof password !== 'string' || !password)
            throw new Error('The adopted password secret has no expected field')
          return { value: password, reference: existingRef + ':' + jsonField + '::' }
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error
      }
      if (!value) throw new Error('The adopted password secret is empty')
      return { value, reference: existingRef }
    })
    return {
      value: $util.secret(decoded.apply((value: { value: string }) => value.value)),
      passwordRef: decoded.apply((value: { reference: string }) => value.reference),
      ready: [] as CloudResource[],
    }
  }
  const password = new random.RandomPassword(name, { length: 32, special: false })
  const secret = new aws.secretsmanager.Secret(name + 'Secret', {
    namePrefix: instanceFor({ app: $app.name, stage: $app.stage, artifact: name.toLowerCase() }) + '-',
    recoveryWindowInDays: 7,
  })
  const version = new aws.secretsmanager.SecretVersion(name + 'Value', {
    secretId: secret.id,
    secretString: $util.secret(password.result),
  })
  return { value: password.result, passwordRef: version.arn, ready: [version] }
}
