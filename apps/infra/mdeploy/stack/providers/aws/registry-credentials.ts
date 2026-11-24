import type { RegistryCredentialStore } from '../../registry-credentials.ts'

export const awsRegistryCredentialStoreProvider =
  ({ accountId, region }: { accountId: string; region: string }) =>
  (): RegistryCredentialStore => {
    // Registry consumers require a flat name ending in a hyphen. Stage names cannot contain underscores.
    const prefix = `registry-credential-${$app.name}_${$app.stage}_-`
    const arn = `arn:aws:secretsmanager:${region}:${accountId}:secret:${prefix}*`
    return {
      active: true,
      binding: {
        cloud: 'aws',
        prefix,
        accountId,
        region,
        writeGrant: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            {
              Effect: 'Allow',
              Action: ['secretsmanager:CreateSecret', 'secretsmanager:PutSecretValue'],
              Resource: arn,
            },
            {
              Effect: 'Allow',
              Action: 'secretsmanager:DeleteSecret',
              Resource: arn,
              Condition: {
                NumericEquals: { 'secretsmanager:RecoveryWindowInDays': 7 },
                BoolIfExists: { 'secretsmanager:ForceDeleteWithoutRecovery': 'false' },
              },
            },
            {
              Effect: 'Deny',
              Action: [
                'secretsmanager:GetSecretValue',
                'secretsmanager:BatchGetSecretValue',
                'secretsmanager:PutResourcePolicy',
              ],
              Resource: arn,
            },
          ],
        }),
        readGrant: JSON.stringify({
          Version: '2012-10-17',
          Statement: [
            { Effect: 'Allow', Action: 'secretsmanager:GetSecretValue', Resource: arn },
            {
              Effect: 'Deny',
              Action: [
                'secretsmanager:CreateSecret',
                'secretsmanager:PutSecretValue',
                'secretsmanager:DeleteSecret',
                'secretsmanager:PutResourcePolicy',
              ],
              Resource: arn,
            },
          ],
        }),
      },
    }
  }
