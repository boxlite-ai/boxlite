// Copyright 2026 BoxLite AI
// SPDX-License-Identifier: AGPL-3.0

import { DescribeVolumesCommand, DescribeVolumesModificationsCommand, ModifyVolumeCommand } from '@aws-sdk/client-ec2'
import { AwsDiskClient } from './aws-disk-client'
import { DiskRateLimitedError } from './disk-client-contract'
import { CloudDiskClient } from './disk-client'

const ref = {
  provider: 'aws',
  project: '123456789012',
  zone: 'us-east-1a',
  diskName: 'vol-0123456789abcdef0',
  diskType: 'gp3',
}
const scope = { accountId: ref.project, region: 'us-east-1', app: 'boxlite-app', stage: 'dev' }
const owner = 'runner-two'
const setup = () => {
  const volume = {
    VolumeId: ref.diskName,
    AvailabilityZone: ref.zone,
    Size: 200,
    VolumeType: 'gp3',
    Tags: [
      { Key: 'boxlite:app', Value: scope.app },
      { Key: 'boxlite:stage', Value: scope.stage },
      { Key: 'boxlite:role', Value: 'runner-data' },
      { Key: 'boxlite:control-plane-runner-name', Value: owner },
    ],
  }
  let modification: Record<string, unknown> | undefined
  const send = jest.fn(async (command) => {
    if (command instanceof DescribeVolumesCommand) return { Volumes: [volume] }
    if (command instanceof DescribeVolumesModificationsCommand)
      return { VolumesModifications: modification ? [modification] : [] }
    if (command instanceof ModifyVolumeCommand) return {}
    throw new Error('unexpected SDK command')
  })
  const client = new AwsDiskClient({ get: () => scope } as any, { client: { send } as any })
  return {
    client,
    send,
    volume,
    setModification: (value: Record<string, unknown>) => {
      modification = value
    },
  }
}
it('grows only the assigned capacity without resetting IOPS, throughput or type', async () => {
  const { client, send } = setup()
  expect(await client.resizeDisk(ref, 400, owner)).toEqual({ operation: ref.diskName + ':400' })
  const command = send.mock.calls.find(([command]) => command instanceof ModifyVolumeCommand)![0]
  expect(command.input).toEqual({ VolumeId: ref.diskName, Size: 400 })
})
it.each([
  { ...ref, project: '999999999999' },
  { ...ref, zone: 'us-west-2a' },
  { ...ref, diskName: 'root' },
  { ...ref, diskType: 'hyperdisk_balanced' },
  { ...ref, provider: 'gcp' },
])('rejects foreign identity before SDK access: %j', async (reference) => {
  const { client, send } = setup()
  await expect(client.resizeDisk(reference, 400, owner)).rejects.toThrow('outside')
  expect(send).not.toHaveBeenCalled()
})
it('refuses another stage, root-volume role or runner before any mutation', async () => {
  for (const [key, value] of [
    ['boxlite:stage', 'prod'],
    ['boxlite:role', 'runner-root'],
    ['boxlite:control-plane-runner-name', 'another'],
  ]) {
    const { client, send, volume } = setup()
    volume.Tags.find((tag) => tag.Key === key)!.Value = value
    await expect(client.resizeDisk(ref, 400, owner)).rejects.toThrow('does not belong')
    expect(send.mock.calls.some(([command]) => command instanceof ModifyVolumeCommand)).toBe(false)
  }
})
it('waits for an existing modification to finish before issuing another one', async () => {
  const { client, send, setModification } = setup()
  setModification({ ModificationState: 'optimizing', TargetSize: 250 })
  await expect(client.resizeDisk(ref, 400, owner)).rejects.toBeInstanceOf(DiskRateLimitedError)
  expect(send.mock.calls.some(([command]) => command instanceof ModifyVolumeCommand)).toBe(false)
})
it('recognizes usable capacity at optimizing and surfaces failed operations', async () => {
  const { client, volume, setModification } = setup()
  volume.Size = 400
  setModification({ ModificationState: 'modifying', VolumeId: ref.diskName, TargetSize: 400 })
  expect(await client.getZoneOperation(ref, ref.diskName + ':400', owner)).toEqual({ status: 'RUNNING' })
  setModification({ ModificationState: 'optimizing', VolumeId: ref.diskName, TargetSize: 400 })
  expect(await client.getZoneOperation(ref, ref.diskName + ':400', owner)).toEqual({ status: 'DONE' })
  setModification({
    ModificationState: 'failed',
    VolumeId: ref.diskName,
    TargetSize: 400,
    StatusMessage: 'capacity unavailable',
  })
  expect(await client.getZoneOperation(ref, ref.diskName + ':400', owner)).toEqual({
    status: 'DONE',
    error: 'capacity unavailable',
  })
})
it('does not resubmit capacity already accepted after a lost response', async () => {
  const { client, send, volume } = setup()
  volume.Size = 400
  await client.resizeDisk(ref, 400, owner)
  expect(send.mock.calls.some(([command]) => command instanceof ModifyVolumeCommand)).toBe(false)
})
it('pins polling to the assigned volume and preserves throttling and permission failures', async () => {
  const { client, send } = setup()
  await expect(client.getZoneOperation(ref, 'vol-fffffffffffffffff:400', owner)).rejects.toThrow('does not identify')
  expect(send).not.toHaveBeenCalled()
  send.mockRejectedValueOnce(Object.assign(new Error('limit'), { name: 'VolumeModificationRateExceeded' }))
  await expect(client.resizeDisk(ref, 400, owner)).rejects.toBeInstanceOf(DiskRateLimitedError)
  send.mockRejectedValueOnce(Object.assign(new Error('denied'), { name: 'UnauthorizedOperation' }))
  await expect(client.resizeDisk(ref, 400, owner)).rejects.toThrow('denied')
})
it('routes provider-specific performance and ownership through the cloud adapters', async () => {
  const baseline = { sizeGb: '200', provisionedIops: '4000', provisionedThroughput: '200' }
  const gcp = { resizeDisk: jest.fn(), getZoneOperation: jest.fn(), getDisk: jest.fn().mockResolvedValue(baseline) }
  const aws = { resizeDisk: jest.fn(), getZoneOperation: jest.fn() }
  const router = new CloudDiskClient(gcp as any, aws as any)
  router.resizeDisk(ref, 400, undefined, owner)
  expect(aws.resizeDisk).toHaveBeenCalledWith(ref, 400, owner)
  expect(gcp.resizeDisk).not.toHaveBeenCalled()
  const gcpRef = { ...ref, provider: 'gcp' }
  const performance = { iops: '8000', throughput: '400' }
  router.resizeDisk(gcpRef, 400, performance)
  expect(gcp.resizeDisk).toHaveBeenCalledWith(gcpRef, 400, performance)
  await expect(router.getDisk(gcpRef)).resolves.toEqual(baseline)
  expect(gcp.getDisk).toHaveBeenCalledWith(gcpRef)
  expect(() => router.resizeDisk(ref, 400, performance, owner)).toThrow('preserves provisioned performance')
  expect(aws.resizeDisk).toHaveBeenCalledTimes(1)
  expect(() => router.resizeDisk({ ...ref, provider: 'unknown' }, 400, undefined, owner)).toThrow('Unsupported')
})
