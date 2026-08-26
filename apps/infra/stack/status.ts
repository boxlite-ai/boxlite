// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2026 BoxLite AI

/// <reference path="../.sst/platform/config.d.ts" />

export { RUNNER_HEARTBEAT_NAMESPACE } from '../status/collector-core.js'

const STATUS_OBJECT_KEY = 'public-status.json'

export interface PublicStatusInputs {
  region: string
  runnerNames: string[]
  stackDomain: string
  cloudflareDns: ReturnType<typeof sst.cloudflare.dns>
}

export function buildPublicStatus(input: PublicStatusInputs) {
  const statusDomain = `status.${input.stackDomain}`
  const snapshotBucket = new sst.aws.Bucket('PublicStatusSnapshots', {
    access: 'cloudfront',
  })

  new sst.aws.Cron('PublicStatusCollector', {
    schedule: 'rate(1 minute)',
    function: {
      handler: 'status/collector.handler',
      timeout: '50 seconds',
      memory: '512 MB',
      environment: {
        STATUS_SNAPSHOT_BUCKET: snapshotBucket.name,
        STATUS_STAGE: $app.stage,
        STATUS_REGIONS: input.region,
        STATUS_RUNNERS: input.runnerNames.join(','),
      },
      permissions: [
        {
          actions: ['s3:PutObject'],
          resources: [$interpolate`${snapshotBucket.arn}/${STATUS_OBJECT_KEY}`],
        },
        {
          actions: [
            'tag:GetResources',
            'ecs:DescribeServices',
            'elasticloadbalancing:DescribeTargetHealth',
            'ec2:DescribeInstances',
            'ec2:DescribeInstanceStatus',
            'cloudwatch:GetMetricData',
          ],
          resources: ['*'],
        },
      ],
    },
  })

  const snapshotOriginInjection = snapshotBucket.nodes.bucket.bucketRegionalDomainName.apply(
    (domain: string) => `
if (event.request.uri === "/${STATUS_OBJECT_KEY}") {
  delete event.request.headers["Cookies"];
  delete event.request.headers["cookies"];
  delete event.request.cookies;
  cf.updateRequestOrigin({
    domainName: "${domain}",
    originAccessControlConfig: {
      enabled: true,
      signingBehavior: "always",
      signingProtocol: "sigv4",
      originType: "s3"
    }
  });
  return event.request;
}`,
  )

  const site = new sst.aws.StaticSite('PublicStatusSite', {
    path: '../status',
    build: {
      command: 'yarn --cwd .. nx run status:build --configuration=production',
      output: '../dist/apps/status',
    },
    environment: {
      VITE_CONSOLE_URL: `https://${input.stackDomain}`,
    },
    domain: {
      name: statusDomain,
      dns: input.cloudflareDns,
    },
    errorPage: 'index.html',
    assets: {
      fileOptions: [
        { files: '**', cacheControl: 'public,max-age=31536000,immutable' },
        { files: '**/*.html', cacheControl: 'no-cache,no-store,must-revalidate' },
      ],
    },
    edge: {
      viewerRequest: { injection: snapshotOriginInjection },
      viewerResponse: {
        injection: `
event.response.headers["strict-transport-security"] = { value: "max-age=63072000; includeSubDomains; preload" };
event.response.headers["x-content-type-options"] = { value: "nosniff" };
event.response.headers["x-frame-options"] = { value: "DENY" };
event.response.headers["referrer-policy"] = { value: "no-referrer" };
event.response.headers["permissions-policy"] = { value: "camera=(), microphone=(), geolocation=()" };
event.response.headers["content-security-policy"] = { value: "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'" };`,
      },
    },
    transform: {
      cdn: (args: any) => {
        args.defaultCacheBehavior = $util.output(args.defaultCacheBehavior).apply((behavior: any) => ({
          ...behavior,
          allowedMethods: ['GET', 'HEAD', 'OPTIONS'],
          cachedMethods: ['GET', 'HEAD'],
        }))
      },
    },
  })

  return {
    url: site.url,
  }
}
