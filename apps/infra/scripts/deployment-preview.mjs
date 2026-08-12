// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import runnerInventory from './runner-inventory.cjs'

const { extraRunnerInstanceProfileName, isRunnerLikeResource } = runnerInventory

const MAX_PREVIEW_BYTES = 32 * 1024 * 1024
const DEV_COMMERCE_TEARDOWN_APPROVAL = '--approve-dev-commerce-teardown'

// The BoxLite stack used to own a Commerce service in dev. Its removal is the
// one reviewed plain-delete migration in this release. Keep the fingerprint
// exact: another stage, type, or logical name must stop for review.
const REVIEWED_DEV_COMMERCE_DELETIONS = new Set([
  'sst:aws:Service::Commerce',
  'aws:appautoscaling/policy:Policy::CommerceAutoScalingCpuPolicy',
  'aws:appautoscaling/policy:Policy::CommerceAutoScalingMemoryPolicy',
  'aws:appautoscaling/target:Target::CommerceAutoScalingTarget',
  'aws:servicediscovery/service:Service::CommerceCloudmapService',
  'pulumi-nodejs:dynamic:Resource::CommerceCNAMEcommerce.dev.boxlite.aiZoneLookup.sst.cloudflare.ZoneLookup',
  'cloudflare:index/dnsRecord:DnsRecord::CommerceCNAMERecordCommercedevboxliteai',
  'sst:sst:DevCommand::CommerceDev',
  'aws:iam/role:Role::CommerceExecutionRole',
  'sst:sst:LinkRef::CommerceLinkRef',
  'aws:lb/listener:Listener::CommerceListenerHTTPS443',
  'aws:lb/loadBalancer:LoadBalancer::CommerceLoadBalancer',
  'aws:ec2/securityGroup:SecurityGroup::CommerceLoadBalancerSecurityGroup',
  'aws:cloudwatch/logGroup:LogGroup::CommerceLogGroupCommerce',
  'aws:ecs/service:Service::CommerceService',
  'sst:aws:Certificate::CommerceSsl',
  'pulumi-nodejs:dynamic:Resource::CommerceSslCAAcommerce.dev.boxlite.aiRecord.sst.cloudflare.DnsRecord',
  'pulumi-nodejs:dynamic:Resource::CommerceSslCAAcommerce.dev.boxlite.aiZoneLookup.sst.cloudflare.ZoneLookup',
  'pulumi-nodejs:dynamic:Resource::CommerceSslCAAWildcardcommerce.dev.boxlite.aiRecord.sst.cloudflare.DnsRecord',
  'aws:acm/certificate:Certificate::CommerceSslCertificate',
  'pulumi-nodejs:dynamic:Resource::CommerceSslCNAME_ad17b0266c7dac87c2dd38e837c1e22f.commerce.dev.boxlite.ai.ZoneLookup.sst.cloudflare.ZoneLookup',
  'cloudflare:index/dnsRecord:DnsRecord::CommerceSslCNAMERecordAd17b0266c7dac87c2dd38e837c1e22fcommercedevboxliteai',
  'aws:acm/certificateValidation:CertificateValidation::CommerceSslValidation',
  'aws:lb/targetGroup:TargetGroup::CommerceTargetCommerceHTTP3100',
  'aws:ecs/taskDefinition:TaskDefinition::CommerceTask',
  'aws:iam/role:Role::CommerceTaskRole',
])

function resourceName(urn) {
  return urn.slice(urn.lastIndexOf('::') + 2)
}

function isReviewedPlainDeletion(change, name, stage) {
  return (
    stage === 'dev' &&
    change.urn.startsWith('urn:pulumi:dev::') &&
    REVIEWED_DEV_COMMERCE_DELETIONS.has(`${change.type}::${name}`)
  )
}

function isAllowedExtraRunnerProfileMigration(change, name, stage) {
  if (!/^Runner-runner-[1-9][0-9]*$/.test(name) || !stage) return false
  let expectedProfile
  try {
    expectedProfile = extraRunnerInstanceProfileName(stage)
  } catch {
    return false
  }
  const oldProfile = change.old?.inputs?.iamInstanceProfile
  const newProfile = change.new?.inputs?.iamInstanceProfile
  return newProfile === expectedProfile && oldProfile !== newProfile
}

function isAllowedRunnerUpdatePath(path, context) {
  return (
    path === '__provider' ||
    path === 'tags' ||
    path.startsWith('tags.') ||
    path.startsWith('tags[') ||
    path === 'tagsAll' ||
    path.startsWith('tagsAll.') ||
    path.startsWith('tagsAll[') ||
    (path === 'iamInstanceProfile' &&
      isAllowedExtraRunnerProfileMigration(context.change, context.name, context.stage))
  )
}

export function validateDeploymentPreview(
  rawPreview,
  {
    stage = process.env.SST_STAGE || process.env.STAGE,
    approveDevCommerceTeardown = false,
  } = {},
) {
  if (typeof approveDevCommerceTeardown !== 'boolean') {
    throw new Error('dev Commerce teardown approval must be boolean')
  }
  let changes
  try {
    changes = JSON.parse(rawPreview)
  } catch (error) {
    throw new Error(`SST deployment preview is not valid JSON: ${error.message}`)
  }
  if (!Array.isArray(changes)) throw new Error('SST deployment preview must be a JSON array')

  const runnerUpdates = []
  const unsafeRunnerChanges = []
  const reviewedDeletes = []
  const unapprovedReviewedDeletes = []
  const unreviewedDeletes = []

  for (const [index, change] of changes.entries()) {
    if (
      !change ||
      typeof change !== 'object' ||
      typeof change.op !== 'string' ||
      typeof change.urn !== 'string' ||
      typeof change.type !== 'string'
    ) {
      throw new Error(`SST deployment preview entry ${index} is not a valid resource change`)
    }

    const name = resourceName(change.urn)
    if (change.op === 'delete') {
      if (isReviewedPlainDeletion(change, name, stage)) {
        const deletion = { name, type: change.type }
        if (approveDevCommerceTeardown) reviewedDeletes.push(deletion)
        else unapprovedReviewedDeletes.push(deletion)
      } else {
        unreviewedDeletes.push(`${name}: ${change.type}`)
      }
    }
    const isRunner =
      isRunnerLikeResource({ name, type: change.type, properties: change.old?.inputs }) ||
      isRunnerLikeResource({ name, type: change.type, properties: change.new?.inputs })
    if (!isRunner) continue

    const paths = Object.keys(change.detailedDiff ?? {})
    const isSafeUpdate =
      change.op === 'update' &&
      change.new?.protect === true &&
      paths.length > 0 &&
      paths.every((path) => isAllowedRunnerUpdatePath(path, { change, name, stage }))

    if (!isSafeUpdate) {
      unsafeRunnerChanges.push(`${name}: ${change.op} (${paths.join(', ') || 'no detailed diff'})`)
      continue
    }
    runnerUpdates.push({ name, paths })
  }

  if (unsafeRunnerChanges.length > 0) {
    throw new Error(`unsafe Runner deployment plan: ${unsafeRunnerChanges.join('; ')}`)
  }

  if (unreviewedDeletes.length > 0) {
    throw new Error(`unreviewed resource deletion: ${unreviewedDeletes.join('; ')}`)
  }

  if (unapprovedReviewedDeletes.length > 0) {
    throw new Error(
      `the reviewed dev Commerce teardown requires explicit one-run approval (${DEV_COMMERCE_TEARDOWN_APPROVAL})`,
    )
  }

  return {
    changeCount: changes.length,
    runnerUpdates,
    ...(reviewedDeletes.length > 0 ? { reviewedDeletes } : {}),
  }
}

async function readPreviewFromStdin() {
  process.stdin.setEncoding('utf8')
  let rawPreview = ''
  let previewBytes = 0

  for await (const chunk of process.stdin) {
    previewBytes += Buffer.byteLength(chunk)
    if (previewBytes > MAX_PREVIEW_BYTES) {
      throw new Error(`SST deployment preview exceeds ${MAX_PREVIEW_BYTES} bytes`)
    }
    rawPreview += chunk
  }
  return rawPreview
}

async function main() {
  const args = process.argv.slice(2)
  if (args.length > 1 || (args.length === 1 && args[0] !== DEV_COMMERCE_TEARDOWN_APPROVAL)) {
    throw new Error(`expected no arguments or exactly ${DEV_COMMERCE_TEARDOWN_APPROVAL}`)
  }
  const preview = validateDeploymentPreview(await readPreviewFromStdin(), {
    approveDevCommerceTeardown: args[0] === DEV_COMMERCE_TEARDOWN_APPROVAL,
  })
  console.log(`deployment-preview: ${preview.changeCount} planned resource change(s) passed the deployment safety gate`)
  for (const update of preview.runnerUpdates) {
    console.log(`deployment-preview: ${update.name} has a safe in-place update (${update.paths.join(', ')})`)
  }
  for (const deletion of preview.reviewedDeletes ?? []) {
    console.log(`deployment-preview: ${deletion.name} has an explicitly reviewed dev Commerce deletion`)
  }
}

// Resolve symlinks, as the other scripts' guards do: `resolve` absolutizes but
// keeps symlinks intact, so a run reached through a symlinked worktree would
// skip this block and let the preview gate exit 0 having checked nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    await main()
  } catch (error) {
    console.error(`deployment-preview: ${error.message}`)
    process.exitCode = 1
  }
}
