/** On-disk full-text index over local sessions: CJK bigrams, incremental refresh over node:sqlite. */

import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import type { Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** One indexed entry that matched a query. */
export interface IndexHit {
  readonly sessionId: string
  readonly seq: number
  readonly time: number
  readonly kind: 'user' | 'assistant'
  readonly snippet: string
}

/** One open index. */
export interface SearchIndex {
  /** Refresh incrementally, then answer one query; `limit` bounds the hits. */
  search(ctx: Context, query: string, limit: number, signal: AbortSignal): Promise<{ hits: IndexHit[]; hasMore: boolean }>
  /** Close the underlying database. */
  close(): void
}

const CJK = /[\u3400-\u9fff\uf900-\ufaff]/
const WORD = /[\p{L}\p{N}_]/u
const SNIPPET_AROUND = 60

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (session_id TEXT PRIMARY KEY, updated_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS bodies (id INTEGER PRIMARY KEY, session_id TEXT NOT NULL, body TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS bodies_session ON bodies(session_id);
CREATE VIRTUAL TABLE IF NOT EXISTS entries USING fts5(tokens, session_id UNINDEXED, seq UNINDEXED, time UNINDEXED, kind UNINDEXED);
`

/**
 * Split text into lowercase Latin/digit words and overlapping CJK bigrams, so a
 * two-character Chinese term is searchable (SQLite's unicode61 tokenizer has no CJK handling).
 * @param text - raw entry text.
 * @returns the index tokens in source order.
 */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  let run = ''
  let runIsCjk = false
  const flush = (): void => {
    if (run === '') return
    if (runIsCjk) {
      for (let at = 0; at + 1 < run.length; at += 1) tokens.push(run.slice(at, at + 2))
      if (run.length === 1) tokens.push(run)
    } else {
      tokens.push(run.toLowerCase())
    }
    run = ''
  }
  for (const char of text) {
    const cjk = CJK.test(char)
    if (!cjk && !WORD.test(char)) {
      flush()
      continue
    }
    if (run !== '' && cjk !== runIsCjk) flush()
    runIsCjk = cjk
    run += char
  }
  flush()
  return tokens
}

/**
 * Mark the first matched token and clip around it.
 * @param body - the entry's original text.
 * @param tokens - the query tokens that were asked for.
 * @returns the snippet, with the matched span wrapped in brackets.
 */
export function highlight(body: string, tokens: readonly string[]): string {
  const lower = body.toLowerCase()
  let at = -1
  let hit = ''
  for (const token of tokens) {
    const found = lower.indexOf(token)
    if (found >= 0 && (at < 0 || found < at)) {
      at = found
      hit = token
    }
  }
  if (at < 0) return body.slice(0, SNIPPET_AROUND * 2)
  const start = Math.max(0, at - SNIPPET_AROUND)
  const end = Math.min(body.length, at + hit.length + SNIPPET_AROUND)
  return `${start === 0 ? '' : '…'}${body.slice(start, at)}[${body.slice(at, at + hit.length)}]${body.slice(at + hit.length, end)}${end === body.length ? '' : '…'}`
}

/** One indexable entry derived from a session event. */
function entryOf(event: SessionEvent): { kind: 'user' | 'assistant'; text: string } | undefined {
  if (event.type === 'user/message') {
    // Human-authored text only, matching the index contract; injected context and peer messages stay out.
    if (event.data.source.kind !== 'user') return undefined
    return { kind: 'user', text: blocks(event.data.content) }
  }
  if (event.type === 'assistant/message') return { kind: 'assistant', text: blocks(event.data.message.content) }
  return undefined
}

/** Joined text of the text blocks in one message. */
function blocks(content: readonly ContentBlock[]): string {
  return content.flatMap(block => (block.type === 'text' ? [block.text] : [])).join(' ')
}

/** One open SQLite index. */
class SessionIndex implements SearchIndex {
  private refreshing: Promise<void> | undefined

  /** @param db - the opened database. */
  constructor(private readonly db: DatabaseSync) {}

  async search(ctx: Context, query: string, limit: number, signal: AbortSignal): Promise<{ hits: IndexHit[]; hasMore: boolean }> {
    await this.refreshOnce(ctx, signal)
    const tokens = tokenize(query)
    if (tokens.length === 0) return { hits: [], hasMore: false }
    const match = tokens.map(token => `"${token.replaceAll('"', '""')}"`).join(' AND ')
    const rows = this.db
      .prepare(
        `SELECT e.session_id AS sessionId, e.seq, e.time, e.kind, b.body
       FROM entries e JOIN bodies b ON b.id = e.rowid
       WHERE entries MATCH ? ORDER BY rank LIMIT ?`
      )
      .all(match, limit + 1) as Array<{ sessionId: string; seq: number; time: number; kind: 'user' | 'assistant'; body: string }>
    return {
      hits: rows.slice(0, limit).map(row => ({
        sessionId: row.sessionId,
        seq: row.seq,
        time: row.time,
        kind: row.kind,
        snippet: highlight(row.body, tokens)
      })),
      hasMore: rows.length > limit
    }
  }

  close(): void {
    this.db.close()
  }

  /** Collapse concurrent refreshes into one in-flight run. */
  private refreshOnce(ctx: Context, signal: AbortSignal): Promise<void> {
    this.refreshing ??= this.refresh(ctx, signal).finally(() => {
      this.refreshing = undefined
    })
    return this.refreshing
  }

  /** Re-read only sessions whose summary moved, then replace their entries. */
  private async refresh(ctx: Context, signal: AbortSignal): Promise<void> {
    const { items } = await ctx.sessionController.list({}, signal)
    const storedAt = this.db.prepare('SELECT updated_at AS updatedAt FROM sessions WHERE session_id = ?')
    for (const summary of items) {
      if (summary.origin === 'subagent') continue
      const stored = storedAt.get(summary.sessionId) as { updatedAt: number } | undefined
      if (stored !== undefined && stored.updatedAt >= summary.updatedAt) continue
      const snapshot = await ctx.sessionQuery.readSession(summary.sessionId)
      this.replace(summary.sessionId, snapshot.events)
      this.db
        .prepare('INSERT INTO sessions(session_id, updated_at) VALUES (?, ?) ON CONFLICT(session_id) DO UPDATE SET updated_at = excluded.updated_at')
        .run(summary.sessionId, summary.updatedAt)
    }
  }

  /** Replace one session's rows with the current events. */
  private replace(sessionId: string, events: readonly SessionEvent[]): void {
    const removeEntry = this.db.prepare('DELETE FROM entries WHERE rowid = ?')
    const removeBody = this.db.prepare('DELETE FROM bodies WHERE id = ?')
    for (const { id } of this.db.prepare('SELECT id FROM bodies WHERE session_id = ?').all(sessionId) as Array<{ id: number }>) {
      removeEntry.run(id)
      removeBody.run(id)
    }
    const insertBody = this.db.prepare('INSERT INTO bodies(session_id, body) VALUES (?, ?)')
    const insertEntry = this.db.prepare('INSERT INTO entries(rowid, tokens, session_id, seq, time, kind) VALUES (?, ?, ?, ?, ?, ?)')
    for (const event of events) {
      const entry = entryOf(event)
      if (entry === undefined) continue
      const tokens = tokenize(entry.text)
      if (tokens.length === 0) continue
      const bodyId = Number(insertBody.run(sessionId, entry.text).lastInsertRowid)
      insertEntry.run(bodyId, tokens.join(' '), sessionId, event.seq, event.time, entry.kind)
    }
  }
}

/**
 * Open or create the index at `path`. Imports node:sqlite lazily so process
 * startup stays free of the experimental-module warning.
 * @param path - absolute database path.
 * @returns the open index.
 */
export async function openSearchIndex(path: string): Promise<SearchIndex> {
  mkdirSync(dirname(path), { recursive: true })
  const { DatabaseSync } = await import('node:sqlite')
  const db = new DatabaseSync(path)
  db.exec(SCHEMA)
  return new SessionIndex(db)
}
