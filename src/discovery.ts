/** Snapshot cursors for the Host-authorized session list. */
import { createHash, randomUUID } from 'node:crypto'

/** Validate a literal query shared by title and event discovery. */
export function literalQuery(value: string): string {
  const query = value.trim()
  if (query.length === 0 || query.length > 500) throw new Error('query must contain 1 through 500 UTF-16 code units')
  return query
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
