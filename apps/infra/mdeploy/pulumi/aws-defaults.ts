import { createHash } from 'node:crypto'
import { instanceFor } from 'naming'
import type { ResourceTransformationArgs, ResourceTransformationResult } from '@pulumi/pulumi'

const PHYSICAL_NAME_PROPERTIES: Readonly<Record<string, string>> = {
  'aws:servicediscovery/privateDnsNamespace:PrivateDnsNamespace': 'name',
  'aws:sesv2/configurationSet:ConfigurationSet': 'configurationSetName',
}

/** Keep generated physical identities inside the bootstrap's app/stage IAM and bucket prefixes. */
const prefixFor = (app: string, stage: string, name: string, limit: number): string => {
  const scope = instanceFor({ app, stage }) + '-'
  const artifact = name.toLowerCase()
  const full = scope + artifact + '-'
  if (full.length <= limit) return full
  const room = limit - scope.length - 10
  if (room < 1) throw new Error('AWS app and stage names leave no room for a scoped physical resource name')
  return scope + artifact.slice(0, room) + '-' + createHash('sha256').update(name).digest('hex').slice(0, 8) + '-'
}

export const awsResourceDefaults =
  ({
    app,
    stage,
    accountId,
    protectedStage,
  }: {
    app: string
    stage: string
    accountId: string
    protectedStage: boolean
  }) =>
  (args: ResourceTransformationArgs): ResourceTransformationResult => {
    const props = { ...args.props }
    const opts = { ...args.opts }
    if (args.type.startsWith('aws:')) {
      if (protectedStage) {
        // Image and environment updates publish a replacement task revision.
        const persistent = args.type !== 'aws:ecs/taskDefinition:TaskDefinition'
        opts.protect = persistent
        opts.retainOnDelete = persistent
      }
      if (
        ['aws:iam/role:Role', 'aws:iam/instanceProfile:InstanceProfile', 'aws:iam/policy:Policy'].includes(args.type) &&
        !props.name &&
        !props.namePrefix
      ) {
        props.namePrefix = prefixFor(app, stage, args.name, 38)
        opts.ignoreChanges = [...new Set([...(opts.ignoreChanges ?? []), 'name', 'namePrefix'])]
      }
      if (args.type === 'aws:s3/bucketV2:BucketV2' && !props.bucket && !props.bucketPrefix) {
        props.bucketPrefix = prefixFor(app, stage, args.name, 37)
        opts.ignoreChanges = [...new Set([...(opts.ignoreChanges ?? []), 'bucket', 'bucketPrefix'])]
      }
      const identityProperty = PHYSICAL_NAME_PROPERTIES[args.type]
      if (identityProperty) {
        opts.ignoreChanges = [...new Set([...(opts.ignoreChanges ?? []), identityProperty])]
      }
      if (args.type === 'aws:iam/role:Role') {
        props.permissionsBoundary = `arn:aws:iam::${accountId}:policy/${instanceFor({ app, stage, artifact: 'runtime-boundary' })}`
      }
    }
    return { props, opts }
  }
