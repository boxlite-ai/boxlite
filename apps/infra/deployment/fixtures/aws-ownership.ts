// Existing subprocess lifecycle fixtures stub the cloud boundary alongside aws/curl/sst.
import { S3Client } from '@aws-sdk/client-s3'
import { SSMClient } from '@aws-sdk/client-ssm'

const objects = new Map<string, { body: string; etag: string }>()
let sequence = 0
Object.assign(SSMClient.prototype, { send: async () => ({ Parameter: { Value: '{"state":"fixture-state"}' } }) })
Object.assign(S3Client.prototype, {
  send: async (command: any) => {
    const { Key, Body, IfMatch, IfNoneMatch } = command.input
    const old = objects.get(Key)
    if (command.constructor.name === 'GetObjectCommand') {
      if (!old) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' })
      return { ETag: old.etag, Body: { transformToString: async () => old.body } }
    }
    if ((IfMatch && IfMatch !== old?.etag) || (IfNoneMatch === '*' && old)) throw new Error('condition failed')
    if (command.constructor.name === 'DeleteObjectCommand') {
      objects.delete(Key)
      return {}
    }
    const ETag = '"' + ++sequence + '"'
    objects.set(Key, { body: String(Body), etag: ETag })
    return { ETag }
  },
})
