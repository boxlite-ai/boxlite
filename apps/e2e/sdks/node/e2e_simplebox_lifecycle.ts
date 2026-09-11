// REST E2E regression: SimpleBox.stop() must delete the box when
// autoRemove is true, not just stop it. `autoRemove` on BoxOptions is a
// deprecated field REST runtimes silently ignore (local runtimes still
// self-delete on stop, which is why this only leaks remotely) - see
// sdks/node/lib/simplebox.ts SimpleBox.stop().

import { ApiKeyCredential, BoxliteRestOptions, JsBoxlite, SimpleBox } from '../../../../sdks/node'
import { DEFAULT_BOX_IMAGE } from '../../../../scripts/test/image.js'
import { setTimeout as delay } from 'node:timers/promises'

function env(name: string, fallback: string): string {
  const value = process.env[name]
  return value && value.length ? value : fallback
}

function isNotFound(error: unknown): boolean {
  return error instanceof Error && error.message.toLowerCase().includes('not found')
}

/**
 * Polls until getInfo reports the box missing, or the timeout elapses.
 *
 * The Node SDK has no typed not-found error over REST, so absence is
 * detected by matching the REST 404 wording in the message rather than a
 * `null` / typed-error check. Any other failure (pending state, transport
 * blip, ...) is retried instead of being treated as proof of deletion - a
 * false "not found" would hide the real leak this driver exists to catch.
 */
async function boxGone(runtime: JsBoxlite, id: string, timeoutMs = 15_000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs
  while (true) {
    try {
      const info = await runtime.getInfo(id)
      if (info == null) return true
    } catch (error) {
      if (isNotFound(error)) return true
      if (Date.now() > deadline) throw error
      await delay(1_000)
      continue
    }
    if (Date.now() > deadline) return false
    await delay(1_000)
  }
}

async function main(): Promise<void> {
  const runtime = JsBoxlite.rest(
    new BoxliteRestOptions({
      url: env('BOXLITE_E2E_URL', 'http://localhost:3000/api'),
      credential: new ApiKeyCredential(env('BOXLITE_E2E_API_KEY', 'devkey')),
      pathPrefix: env('BOXLITE_E2E_PREFIX', ''),
    }),
  )
  const image = env('BOXLITE_E2E_IMAGE', DEFAULT_BOX_IMAGE)

  const removedBox = new SimpleBox({ image, runtime, autoRemove: true })
  const removedId = await removedBox.getId()
  await removedBox.stop()
  if (!(await boxGone(runtime, removedId))) {
    throw new Error(`box ${removedId} is still present after stop() with autoRemove=true`)
  }
  console.log('AUTOREMOVE_TRUE_DELETES=ok')

  const keptBox = new SimpleBox({ image, runtime, autoRemove: false })
  const keptId = await keptBox.getId()
  await keptBox.stop()
  try {
    const info = await runtime.getInfo(keptId)
    if (info == null) throw new Error(`box ${keptId} was deleted despite autoRemove=false`)
  } finally {
    // stop() above can leave the box briefly `pending` server-side; retry
    // once past that window, same as the retry inside SimpleBox.stop()
    // itself. A failure here would leak this box, so it's rethrown rather
    // than swallowed.
    await delay(1_000)
    await runtime.remove(keptId, true)
  }
  console.log('AUTOREMOVE_FALSE_KEEPS=ok')
}

void main().catch((error: unknown) => {
  console.error(error)
  process.exitCode = 1
})
