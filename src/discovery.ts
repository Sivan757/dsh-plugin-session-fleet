/** Snapshot cursors for the Host-authorized session list. */
import { createHash, randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'

const listCursor = z.object({ version: z.const(1).required(), fingerprint: z.string().required(), offset: z.natural().max(Number.MAX_SAFE_INTEGER).required() })

/** Validate a literal query shared by title and event discovery. */
export function literalQuery(value: string): string {
  const query = value.trim()
  if (query.length === 0 || query.length > 500) throw new Error('query must contain 1 through 500 UTF-16 code units')
  return query
}

/** Slice one stable authorized listing; a changed query or corpus invalidates its cursor. */
export function sessionListPage(rows: readonly SessionSummary[], limit: number, scope: { cwd: string | undefined; query: string | undefined }, cursor?: string) {
  const fingerprint = createHash('sha256')
    .update(JSON.stringify([scope ?? null, limit, rows.map(row => [row.sessionId, row.updatedAt, row.cwd, row.origin, row.projections?.values.title])]))
    .digest('base64url')
  let offset = 0
  if (cursor !== undefined) {
    let decoded: ReturnType<typeof listCursor>
    try {
      if (cursor.length > 256 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new Error('invalid encoding')
      decoded = listCursor(JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')))
    } catch (error) {
      throw new Error('Invalid list cursor. Restart list_sessions without a cursor.', { cause: error })
    }
    if (decoded.fingerprint !== fingerprint) throw new Error('Session list or filters changed. Restart list_sessions without a cursor.')
    offset = decoded.offset
    if (offset >= rows.length) throw new Error('List cursor is outside the current result. Restart without a cursor.')
  }
  const page = rows.slice(offset, offset + limit)
  const hasMore = offset + page.length < rows.length
  return { rows: page, hasMore, ...(hasMore ? { nextCursor: Buffer.from(JSON.stringify({ version: 1, fingerprint, offset: offset + page.length })).toString('base64url') } : {}) }
}

/** Stable request identity; authorization is resolved again for every page. */
export interface SearchIdentity {
  query: string
  cwd: string | undefined
  from: number | undefined
  to: number | undefined
  limit: number
  includeSubagents: boolean
}
interface SearchState {
  fingerprint: string
  seen: readonly string[]
}

/** Bounded continuation state, not a message index or a cached authorization decision. */
export class SearchContinuations {
  private readonly states = new Map<string, SearchState & { expiresAt: number }>()
  private closed = false
  constructor(private readonly limits: { maxEntries: number; ttlSeconds: number; maxSessions: number }) {}

  /** Bind an opaque handle to its caller and unchanged request. */
  begin(owner: string, identity: SearchIdentity, cursor?: string): SearchState {
    if (this.closed) throw new Error('Session Fleet was unloaded')
    this.prune()
    const fingerprint = createHash('sha256')
      .update(JSON.stringify([owner, identity]))
      .digest('base64url')
    if (cursor === undefined) return { fingerprint, seen: [] }
    const state = this.states.get(cursor)
    if (state === undefined || state.fingerprint !== fingerprint) throw new Error('Invalid, expired, or mismatched search cursor. Restart search_sessions without a cursor.')
    return state
  }

  /** Limit retained IDs as well as the number and lifetime of handles. */
  remaining(state: SearchState): number {
    return this.limits.maxSessions - state.seen.length
  }

  /** Record only emitted session IDs; each next query excludes them from its authorized ID set. */
  next(state: SearchState, ids: readonly string[]): string {
    if (this.closed) throw new Error('Session Fleet was unloaded')
    const seen = [...new Set([...state.seen, ...ids])]
    if (seen.length > this.limits.maxSessions) throw new Error('Search continuation limit reached; narrow cwd or the time window.')
    this.prune()
    while (this.states.size >= this.limits.maxEntries) this.states.delete(this.states.keys().next().value!)
    const cursor = 'fleet-search-v1.' + randomUUID()
    this.states.set(cursor, { fingerprint: state.fingerprint, seen, expiresAt: Date.now() + this.limits.ttlSeconds * 1000 })
    return cursor
  }

  /** Release all handles when the owning plugin is unloaded. */
  dispose(): void {
    this.closed = true
    this.states.clear()
  }

  private prune(): void {
    for (const [key, state] of this.states) if (state.expiresAt <= Date.now()) this.states.delete(key)
  }
}
