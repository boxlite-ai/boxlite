/*
 * Copyright 2025 BoxLite AI
 * SPDX-License-Identifier: AGPL-3.0
 */

/**
 * RFC 4251 section 5 primitives. Every OpenSSH public key, signature and
 * certificate is a concatenation of these, so the encoder/decoder is shared by
 * the public-key parser, the certificate builder and every signer adapter.
 */

export class SshWireFormatError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SshWireFormatError'
  }
}

export class SshWireWriter {
  private readonly chunks: Buffer[] = []

  writeString(value: string | Buffer): this {
    const payload = Buffer.isBuffer(value) ? value : Buffer.from(value, 'utf8')
    const header = Buffer.allocUnsafe(4)
    header.writeUInt32BE(payload.length, 0)
    this.chunks.push(header, payload)
    return this
  }

  writeUint32(value: number): this {
    const buffer = Buffer.allocUnsafe(4)
    buffer.writeUInt32BE(value, 0)
    this.chunks.push(buffer)
    return this
  }

  writeUint64(value: bigint): this {
    const buffer = Buffer.allocUnsafe(8)
    buffer.writeBigUInt64BE(value, 0)
    this.chunks.push(buffer)
    return this
  }

  /** A `string` whose payload is itself a sequence of `string`s (e.g. valid principals). */
  writeStringSequence(values: readonly string[]): this {
    const inner = new SshWireWriter()
    for (const value of values) {
      inner.writeString(value)
    }
    return this.writeString(inner.toBuffer())
  }

  /**
   * A `string` whose payload is a sequence of `string name, string data` pairs
   * (critical options and extensions). OpenSSH requires the names to be
   * lexically ordered, so the caller must pass them sorted.
   */
  writeNameDataPairs(pairs: ReadonlyArray<readonly [string, string | Buffer]>): this {
    const inner = new SshWireWriter()
    for (const [name, data] of pairs) {
      inner.writeString(name)
      inner.writeString(data)
    }
    return this.writeString(inner.toBuffer())
  }

  toBuffer(): Buffer {
    return Buffer.concat(this.chunks)
  }
}

export class SshWireReader {
  private offset = 0

  constructor(private readonly buffer: Buffer) {}

  get remaining(): number {
    return this.buffer.length - this.offset
  }

  readString(): Buffer {
    if (this.remaining < 4) {
      throw new SshWireFormatError('truncated string length prefix')
    }
    const length = this.buffer.readUInt32BE(this.offset)
    this.offset += 4
    if (length > this.remaining) {
      throw new SshWireFormatError('string length exceeds available bytes')
    }
    const value = this.buffer.subarray(this.offset, this.offset + length)
    this.offset += length
    return value
  }

  readUtf8String(): string {
    return this.readString().toString('utf8')
  }
}
