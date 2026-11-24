import { workloadSecretPath } from './secret-names.ts'

/** Create a stage-owned password sealed in Pulumi state and Secrets Manager. */
export const awsPassword = (name: string) => {
  const password = new random.RandomPassword(name, { length: 32, special: false })
  const secret = new aws.secretsmanager.Secret(name + 'Secret', {
    namePrefix: `${workloadSecretPath($app.name, $app.stage)}${name.toLowerCase()}-`,
    recoveryWindowInDays: 7,
  })
  const version = new aws.secretsmanager.SecretVersion(name + 'Value', {
    secretId: secret.id,
    secretString: $util.secret(password.result),
  })
  return { value: password.result, passwordRef: version.arn, ready: [version] }
}
