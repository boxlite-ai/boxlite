// Claude runs these handlers after the session authorizes the registered tool and its input.

class TransferError extends Error {}

async function archive($, operation, path, input) {
  const worker = $.plugin.root + '/skills/boxlite/scripts/archive_worker.py'
  const process = $.process.spawn({argv: ['python3', '-E', '-s', '-B', worker, operation, path], input})
  const chunks = []
  let error = ''
  try {
    for (;;) {
      const event = await process.next()
      if (event.done) {
        if (event.value.code === 2) throw new TransferError(error.trim() || 'Archive operation failed')
        if (event.value.code !== 0) throw new TransferError('Archive worker failed')
        return chunks.join('')
      }
      const {stream, text} = event.value
      if (stream === 'stderr') {
        error = (error + text).slice(0, 512)
      } else {
        chunks.push(text)
      }
    }
  } finally {
    await process.return()
  }
}

function fileErrorMessage(tool, result) {
  const item = Array.isArray(result.content) && result.content.length === 1 ? result.content[0] : null
  const text = item?.type === 'text' && typeof item.text === 'string' ? item.text : ''
  let detail = result.structuredContent
  if (detail == null && text.trimStart().startsWith('{')) {
    try { detail = JSON.parse(text) } catch { /* Unrecognized server text uses the generic message. */ }
  }
  if (detail?.statusCode === 403 || text === 'HTTP 403') {
    return tool === 'downloadFiles'
      ? 'Server refused the download (HTTP 403). Check connection permissions. BoxLite Cloud requires write:boxes'
      : 'Server refused the upload (HTTP 403). Check permissions for the selected connection'
  }
  const code = detail?.error?.code
  if (text === 'Invalid value for path argument box_id') return 'Invalid Box ID. Check the selected Box ID'
  if (code === 'invalid_argument') return 'Invalid transfer arguments. Check the remote path'
  if (code === 'not_found' || detail?.statusCode === 404 || text === 'HTTP 404') {
    return 'Resource not found. Check the Box ID and remote path'
  }
  if (code === 'invalid_state') return 'Transfer unavailable in the current Box state. Check the Box status'
  if (tool === 'downloadFiles' && /^(?:GET \/\S+ returned more than 8388608 bytes|Response of [0-9]+ bytes exceeds the 8388608-byte limit)$/.test(text)) {
    return 'Download exceeds the 8 MiB limit. Select fewer or smaller files'
  }
  return tool + ' failed on the selected connection; completion is unknown'
}

async function callFileTool($, connection, tool, input) {
  let result
  try {
    result = await $.mcp.call(connection, tool, input)
  } catch {
    // Host exceptions can contain the raw request or response.
  }
  if (result && !result.isError) return result
  if (result?.isError === true) throw new TransferError(fileErrorMessage(tool, result))
  throw new TransferError(tool + ' failed on the selected connection; completion is unknown')
}

async function upload($, args) {
  const body = await archive($, 'pack', args.local_source)
  const result = await callFileTool($, args.connection, 'uploadFiles', {
    box_id: args.box_id, path: args.remote_destination, body_base64: body,
  })
  const content = result.content
  if (content?.length !== 1 || content[0]?.type !== 'text' || content[0].text !== 'HTTP 204') {
    throw new TransferError('uploadFiles returned no HTTP 204 acknowledgment; completion is unknown')
  }
  return args.remote_destination
}

async function download($, args) {
  await archive($, 'check', args.local_destination)
  const started = Date.now()
  const result = await callFileTool($, args.connection, 'downloadFiles', {
    box_id: args.box_id, path: args.remote_source,
  })
  const finished = Date.now()
  let data = result.structuredContent
  if (data == null && result.content?.length === 1 && result.content[0]?.type === 'text') {
    const text = result.content[0].text
    const notice = /^Error: result \([\d,]+ characters(?: across [\d,]+ lines?)?\) exceeds maximum allowed tokens\. Output has been saved to ([^\n]+)\.\nFormat: (?:JSON|Plain text)/.exec(text)
    if (notice) {
      const {transcriptPath} = await $.session.info()
      const receipt = {transcriptPath, connection: args.connection, started, finished, path: notice[1]}
      await archive($, 'save-result', args.local_destination, JSON.stringify(receipt))
      return args.local_destination
    }
    try {
      data = JSON.parse(text)
    } catch {
      throw new TransferError('downloadFiles returned malformed archive metadata')
    }
  }
  if (typeof data?.base64 !== 'string') {
    throw new TransferError('downloadFiles returned no archive bytes')
  }
  await archive($, 'save', args.local_destination, data.base64)
  return args.local_destination
}

const operations = [
  {name: 'upload', paths: ['local_source', 'remote_destination'],
    description: 'Upload a local file or directory to a Box. Supply the selected MCP connection and absolute paths.'},
  {name: 'download', paths: ['remote_source', 'local_destination'],
    description: 'Download from a Box into a new local directory. Supply the selected MCP connection and absolute paths.'},
]

export function register(on) {
  on('session.start', async ($, event, next) => {
    for (const {name, paths, description} of operations) {
      const required = ['connection', 'box_id', ...paths]
      const properties = Object.fromEntries(required.map(key => [key, {type: 'string', minLength: 1}]))
      await $.tool.register({name, description, inputSchema: {type: 'object', properties, required, additionalProperties: false}})
    }
    return next(event)
  })
  for (const {name, paths} of operations) {
    on('tool.run', {tool: 'mcp__boxlite__' + name}, async ($, args) => {
      if (!paths.every(key => args[key]?.startsWith('/'))) return {deny: 'Use absolute transfer paths'}
      try {
        const destination = name === 'upload' ? await upload($, args) : await download($, args)
        return {result: JSON.stringify({operation: name, status: 'completed', box_id: args.box_id, destination})}
      } catch (error) {
        return {deny: error instanceof TransferError ? error.message : 'BoxLite transfer failed; completion is unknown'}
      }
    }).catch(() => ({deny: 'BoxLite transfer failed; completion is unknown'}))
  }
}
