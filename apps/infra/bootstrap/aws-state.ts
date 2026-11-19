import { randomBytes } from 'node:crypto'
import {
  CreateBucketCommand,
  HeadBucketCommand,
  PutBucketEncryptionCommand,
  PutBucketVersioningCommand,
  PutPublicAccessBlockCommand,
} from '@aws-sdk/client-s3'
import { GetParameterCommand, PutParameterCommand } from '@aws-sdk/client-ssm'
import { setValues, type Clients } from 'mstage/env'

const missing = (error: any) =>
  ['ParameterNotFound', 'NotFound', 'NoSuchBucket'].includes(error?.name) || error?.$metadata?.httpStatusCode === 404

/** Create the regional state bucket and initialize an encrypted configuration for this stage. */
export const bootstrapAwsState = async ({
  clients,
  app,
  stage,
  accountId,
  region,
}: {
  clients: Clients
  app: string
  stage: string
  accountId: string
  region: string
}): Promise<string> => {
  if (
    !/^[a-z0-9][a-z0-9-]{0,45}$/.test(app) ||
    !/^[a-z0-9][a-z0-9-]{0,30}$/.test(stage) ||
    !/^[0-9]{12}$/.test(accountId) ||
    !/^[a-z]{2}-[a-z]+-[0-9]+$/.test(region)
  )
    throw new Error('Invalid AWS bootstrap coordinates')
  const parameter = async (Name: string): Promise<string | null> => {
    try {
      const result = await clients.ssm.send(new GetParameterCommand({ Name, WithDecryption: true }))
      if (!result.Parameter?.Value) throw new Error(`${Name} has no value; refusing to overwrite it`)
      return result.Parameter.Value
    } catch (error) {
      if (missing(error)) return null
      throw error
    }
  }
  let stored = await parameter('/boxlite/pulumi/bootstrap')
  let bucket = `boxlite-pulumi-state-${region}-${accountId}`
  if (stored) {
    const bootstrap = JSON.parse(stored)
    if (typeof bootstrap.state !== 'string') throw new Error('/boxlite/pulumi/bootstrap names no state bucket')
    bucket = bootstrap.state
  }
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket)) throw new Error('Invalid AWS state bucket')
  try {
    await clients.s3.send(new HeadBucketCommand({ Bucket: bucket }))
  } catch (error) {
    if (!missing(error)) throw error
    if (stored)
      throw new Error(`Recorded state bucket ${bucket} is missing; restore the state bucket before bootstrap`, {
        cause: error,
      })
    try {
      await clients.s3.send(
        new CreateBucketCommand({
          Bucket: bucket,
          ...(region === 'us-east-1' ? {} : { CreateBucketConfiguration: { LocationConstraint: region as any } }),
        }),
      )
      await clients.s3.send(
        new PutBucketEncryptionCommand({
          Bucket: bucket,
          ServerSideEncryptionConfiguration: {
            Rules: [{ ApplyServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }],
          },
        }),
      )
    } catch (error: any) {
      if (error?.name !== 'BucketAlreadyOwnedByYou') throw error
    }
  }
  await clients.s3.send(
    new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }),
  )
  await clients.s3.send(
    new PutPublicAccessBlockCommand({
      Bucket: bucket,
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    }),
  )
  if (!stored) {
    try {
      await clients.ssm.send(
        new PutParameterCommand({
          Name: '/boxlite/pulumi/bootstrap',
          Type: 'String',
          Value: JSON.stringify({ state: bucket }),
          Overwrite: false,
        }),
      )
    } catch (error: any) {
      if (error?.name !== 'ParameterAlreadyExists') throw error
    }
    stored = await parameter('/boxlite/pulumi/bootstrap')
    if (!stored || JSON.parse(stored).state !== bucket)
      throw new Error('Concurrent bootstrap selected another state bucket; inspect before retrying')
  }
  const name = `/boxlite/pulumi/passphrase/${app}/${stage}`
  if (!(await parameter(name))) {
    try {
      await clients.ssm.send(
        new PutParameterCommand({
          Name: name,
          Type: 'SecureString',
          Value: randomBytes(32).toString('base64'),
          Overwrite: false,
        }),
      )
    } catch (error: any) {
      if (error?.name !== 'ParameterAlreadyExists') throw error
    }
  }
  await setValues({
    clients,
    app,
    stage,
    entries: [],
    derive: (values) =>
      values.PULUMI_CONFIG_PASSPHRASE ? [] : [['PULUMI_CONFIG_PASSPHRASE', randomBytes(32).toString('base64')]],
  })
  return bucket
}
