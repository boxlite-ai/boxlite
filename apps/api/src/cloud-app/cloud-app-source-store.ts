import { Injectable } from '@nestjs/common'
import { Storage } from '@google-cloud/storage'
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { TypedConfigService } from '../config/typed-config.service'
import { fail } from './engine/errors'
import type { AppSourceStore } from './engine/ctx'

@Injectable()
export class CloudAppSourceStore implements AppSourceStore {
  private readonly s3: S3Client
  private readonly gcs: Storage

  constructor(private readonly config: TypedConfigService) {
    const storage = config.get('s3')
    this.s3 = new S3Client({
      region: storage.region,
      endpoint: storage.endpoint,
      forcePathStyle: Boolean(storage.accessKey),
      ...(storage.accessKey && storage.secretKey
        ? { credentials: { accessKeyId: storage.accessKey, secretAccessKey: storage.secretKey } }
        : {}),
    })
    this.gcs = new Storage({ projectId: config.get('gcs.projectId') })
  }

  private settings() {
    const settings = this.config.get('cloudApps')
    if (!settings.sourceBucket) throw fail('unavailable', 'App source storage is not configured')
    return settings
  }

  private key(appId: string, sha?: string): string {
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(appId) || (sha !== undefined && !/^[a-f0-9]{64}$/.test(sha))) {
      throw fail('invalid_request', 'Invalid App source object')
    }
    return `${this.settings().sourcePrefix}/${appId}/${sha ?? ''}`
  }

  async has(appId: string, sha: string): Promise<boolean> {
    const { sourceBackend, sourceBucket } = this.settings()
    const key = this.key(appId, sha)
    if (sourceBackend === 'gcs') return (await this.gcs.bucket(sourceBucket).file(key).exists())[0]
    try {
      await this.s3.send(new HeadObjectCommand({ Bucket: sourceBucket, Key: key }))
      return true
    } catch (error) {
      if ((error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode === 404) return false
      throw error
    }
  }

  async put(appId: string, sha: string, body: Readable, maxBytes: number) {
    const key = this.key(appId, sha)
    if (await this.has(appId, sha)) {
      body.resume()
      return { bytes: 0, deduped: true }
    }
    const chunks: Buffer[] = []
    const hash = createHash('sha256')
    let bytes = 0
    for await (const chunk of body) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) throw fail('invalid_manifest', `Source file exceeds ${maxBytes} bytes`)
      hash.update(buffer)
      chunks.push(buffer)
    }
    if (hash.digest('hex') !== sha) throw fail('checksum_mismatch', 'Source content does not match its upload manifest')
    const { sourceBackend, sourceBucket } = this.settings()
    const value = Buffer.concat(chunks)
    if (sourceBackend === 'gcs') await this.gcs.bucket(sourceBucket).file(key).save(value, { resumable: false })
    else await this.s3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: key, Body: value }))
    return { bytes, deduped: false }
  }

  read(appId: string, sha: string): Readable {
    const { sourceBackend, sourceBucket } = this.settings()
    const key = this.key(appId, sha)
    if (sourceBackend === 'gcs') return this.gcs.bucket(sourceBucket).file(key).createReadStream()
    const client = this.s3
    return Readable.from(
      (async function* () {
        const object = await client.send(new GetObjectCommand({ Bucket: sourceBucket, Key: key }))
        if (!object.Body) throw fail('not_found', 'App source object is missing')
        yield* object.Body as Readable
      })(),
    )
  }

  async deleteApp(appId: string): Promise<void> {
    const { sourceBackend, sourceBucket } = this.settings()
    const prefix = this.key(appId)
    if (sourceBackend === 'gcs') {
      await this.gcs.bucket(sourceBucket).deleteFiles({ prefix })
      return
    }
    let continuationToken: string | undefined
    do {
      const page = await this.s3.send(
        new ListObjectsV2Command({ Bucket: sourceBucket, Prefix: prefix, ContinuationToken: continuationToken }),
      )
      if (page.Contents?.length) {
        const result = await this.s3.send(
          new DeleteObjectsCommand({
            Bucket: sourceBucket,
            Delete: { Objects: page.Contents.map(({ Key }) => ({ Key })) },
          }),
        )
        if (result.Errors?.length) throw new Error('App source cleanup did not delete every object')
      }
      continuationToken = page.NextContinuationToken
    } while (continuationToken)
  }
}
