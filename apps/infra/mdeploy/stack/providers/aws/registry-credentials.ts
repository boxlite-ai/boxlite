import type { RegistryCredentialStore } from '../../registry-credentials.ts'
import { instanceFor } from 'naming'

export const awsRegistryCredentialStoreProvider =
  ({ accountId, region }: { accountId: string; region: string }) =>
  (): RegistryCredentialStore => {
    const prefix = 'registry-credential-' + instanceFor({ app: $app.name, stage: $app.stage }) + '-'
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
