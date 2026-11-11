/** Private, bounded text projections owned by one mounted Fleet plugin. */
import { mkdtemp, open, rename, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { scheduler } from 'node:timers/promises'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

export const TRANSCRIPT_EVENT_TYPES = ['user/message', 'assistant/message', 'tool/call'] as const

/** Deployment limits for temporary text projections. */
export interface TranscriptLimits {
  maxBytes: number
  maxFiles: number
  ttlSeconds: number
  chunkChars: number
}

function escapeField(text: string): string {
  return text.replaceAll('\\', '\\\\').replaceAll('\r', '\\r').replaceAll('\n', '\\n').replaceAll('\t', '\\t')
}

function partsOf(event: SessionEvent): { role: string; source: string; messageId: string; parts: string[] } | undefined {
  if (event.type === 'tool/call') return { role: 'tool', source: event.data.name, messageId: '', parts: [event.data.arguments] }
  if (event.type === 'user/message')
    return { role: 'user', source: event.data.source.kind, messageId: event.data.id, parts: event.data.content.flatMap(block => (block.type === 'text' ? [block.text] : [])) }
  if (event.type === 'assistant/message')
    return { role: 'assistant', source: 'model', messageId: event.data.message.id, parts: event.data.message.content.flatMap(block => (block.type === 'text' ? [block.text] : [])) }
  return undefined
}

/** Serializes exports and cleanup so disposal cannot remove an active export's directory. */
export class TranscriptStore {
  private directory?: string
  private readonly closed = new AbortController()
  private readonly files = new Map<string, number>()
  private tail: Promise<void> = Promise.resolve()
  private timer: ReturnType<typeof setTimeout> | undefined

  constructor(
    private readonly limits: TranscriptLimits,
    private readonly reportCleanupError: (error: unknown) => void
  ) {}

  /** Export one immutable event prefix; callers retain responsibility for current session authorization. */
  export(events: readonly SessionEvent[], signal: AbortSignal) {
    const combined = AbortSignal.any([signal, this.closed.signal])
    const work = this.tail.then(() => this.write(events, combined))
    // Each caller receives its own failure; later independent requests may still run.
    this.tail = work.then(
      () => {},
      () => {}
    )
    return work
  }

  /** Stop admission, settle active I/O, and remove only this store's acquired private directory. */
  async dispose(): Promise<void> {
    this.closed.abort(new Error('Session Fleet was unloaded'))
    clearTimeout(this.timer)
    await this.tail
    if (this.directory !== undefined) await rm(this.directory, { recursive: true, force: true })
    this.files.clear()
  }

  private schedule(): void {
    clearTimeout(this.timer)
    if (this.closed.signal.aborted || this.files.size === 0) return
    let first = Infinity
    for (const expiresAt of this.files.values()) first = Math.min(first, expiresAt)
    this.timer = setTimeout(
      () => {
        this.timer = undefined
        const cleanup = this.tail.then(() => this.expire())
        this.tail = cleanup.catch(error => this.reportCleanupError(error))
      },
      Math.max(1, first - Date.now())
    )
    this.timer.unref()
  }

  private async expire(): Promise<void> {
    for (const [path, expiresAt] of this.files) {
      if (expiresAt > Date.now()) continue
      await rm(path, { force: true })
      this.files.delete(path)
    }
    this.schedule()
  }

  private async write(events: readonly SessionEvent[], signal: AbortSignal) {
    signal.throwIfAborted()
    await this.expire()
    while (this.files.size >= this.limits.maxFiles) {
      const oldest = this.files.keys().next().value!
      await rm(oldest, { force: true })
      this.files.delete(oldest)
    }
    this.directory ??= await mkdtemp(join(tmpdir(), 'dsh-session-fleet-'))
    const path = join(this.directory, randomUUID() + '.tsv')
    const temporary = path + '.part'
    let bytes = 0
    let lines = 0
    let truncated = false
    try {
      const file = await open(temporary, 'wx', 0o600)
      try {
        outer: for (const event of events) {
          signal.throwIfAborted()
          const row = partsOf(event)
          if (row === undefined) continue
          await scheduler.yield()
          let chunk = 0
          for (let part = 0; part < row.parts.length; part++) {
            const text = row.parts[part]!
            for (let offset = 0; offset < text.length || offset === 0;) {
              const prefix = part > 0 && offset === 0 ? ' ' : ''
              let end = Math.min(text.length, offset + this.limits.chunkChars - prefix.length)
              const code = text.charCodeAt(end - 1)
              if (end < text.length && code >= 0xd800 && code <= 0xdbff) end--
              const line =
                [event.seq, new Date(event.time).toISOString(), row.role, escapeField(row.source), ++chunk, row.messageId, escapeField(prefix + text.slice(offset, end))].join(
                  '\t'
                ) + '\n'
              const size = Buffer.byteLength(line)
              if (bytes + size > this.limits.maxBytes) {
                truncated = true
                break outer
              }
              signal.throwIfAborted()
              await file.writeFile(line, 'utf8')
              bytes += size
              lines++
              if (end >= text.length) break
              offset = end
            }
          }
        }
      } finally {
        await file.close()
      }
      signal.throwIfAborted()
      await rename(temporary, path)
    } catch (error) {
      await rm(temporary, { force: true })
      throw error
    }
    const expiresAt = Date.now() + this.limits.ttlSeconds * 1000
    this.files.set(path, expiresAt)
    this.schedule()
    return { transcriptPath: path, transcriptLines: lines, transcriptBytes: bytes, transcriptTruncated: truncated, transcriptExpiresAt: new Date(expiresAt).toISOString() }
  }
}
