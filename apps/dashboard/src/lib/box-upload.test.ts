// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import {
  buildBoxFileUploadPath,
  buildBoxUploadItems,
  buildBoxUploadPath,
  createBoxUploadTar,
  createSingleFileTar,
} from './box-upload'

describe('box upload helpers', () => {
  it('uploads file basenames into /workspace by default', () => {
    expect(buildBoxFileUploadPath('/workspace', new File(['x'], 'test.zip'))).toBe('/workspace/test.zip')
  })

  it('normalizes destination directories without escaping /workspace', () => {
    expect(buildBoxFileUploadPath('/workspace/', new File(['x'], '../secret.txt'))).toBe('/workspace/secret.txt')
  })

  it('keeps dotfile basenames intact', () => {
    expect(buildBoxFileUploadPath('/workspace', new File(['x'], '.env'))).toBe('/workspace/.env')
  })

  it('creates a tar archive that contains the file payload and ustar marker', async () => {
    const tar = await createSingleFileTar(new File(['hello'], 'note.txt'))
    const bytes = await readBlobBytes(tar)
    const text = new TextDecoder().decode(bytes)

    expect(tar.type).toBe('application/x-tar')
    expect(text.slice(0, 512)).toContain('note.txt')
    expect(text.slice(0, 512)).toContain('ustar')
    expect(text).toContain('hello')
    expect(bytes.length % 512).toBe(0)
  })

  it('rejects tar octal header values that do not fit', async () => {
    const file = new File(['hello'], 'note.txt', { lastModified: Number.MAX_SAFE_INTEGER })

    await expect(createSingleFileTar(file)).rejects.toThrow('Tar header value')
  })

  it('groups browser directory selections by root folder', () => {
    const first = fileWithRelativePath('one', 'project/src/index.ts')
    const second = fileWithRelativePath('two', 'project/README.md')
    const [item] = buildBoxUploadItems([first, second])

    expect(item.kind).toBe('directory')
    expect(item.name).toBe('project')
    expect(buildBoxUploadPath('/workspace', item)).toBe('/workspace/project')
    expect(item.files.map((entry) => entry.relativePath)).toEqual(['src/index.ts', 'README.md'])
  })

  it('creates a folder tar with relative file paths', async () => {
    const [item] = buildBoxUploadItems([
      fileWithRelativePath('one', 'project/src/index.ts'),
      fileWithRelativePath('two', 'project/README.md'),
    ])
    const tar = await createBoxUploadTar(item)
    const bytes = await readBlobBytes(tar)
    const text = new TextDecoder().decode(bytes)

    expect(tar.type).toBe('application/x-tar')
    expect(text).toContain('src/index.ts')
    expect(text).toContain('README.md')
    expect(text).toContain('one')
    expect(text).toContain('two')
    expect(text).not.toContain('project/src/index.ts')
    expect(bytes.length % 512).toBe(0)
  })
})

function fileWithRelativePath(contents: string, relativePath: string): File {
  const fileName = relativePath.split('/').pop() ?? 'file'
  const file = new File([contents], fileName)
  Object.defineProperty(file, 'webkitRelativePath', {
    configurable: true,
    value: relativePath,
  })
  return file
}

async function readBlobBytes(blob: Blob): Promise<Uint8Array> {
  if (typeof blob.arrayBuffer === 'function') {
    return new Uint8Array(await blob.arrayBuffer())
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read blob'))
    reader.onload = () => resolve(new Uint8Array(reader.result as ArrayBuffer))
    reader.readAsArrayBuffer(blob)
  })
}
