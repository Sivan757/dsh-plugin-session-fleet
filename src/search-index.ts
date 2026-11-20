/** Long-lived full-text index over DSH session logs, owned by the Session Fleet plugin. */
import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

/** One session log file on disk, identified by path and stat identity. */
interface SessionSource {
  path: string
  size: number
  mtimeNs: bigint
}

/** One searchable excerpt extracted from a session event. */
interface IndexedDocument {
  seq: number
  type: string
  time: number
  text: string
}

/** Tunables for the incremental synchronisation pass. */
export interface SyncOptions {
  /** Maximum sessions to (re)index in one pass. */
  maxSessions?: number
  /** Wall-clock budget for the pass in milliseconds. */
  budgetMs?: number
}

/** One hit returned to the model. */
export interface SearchHit {
  sessionId: string
  seq: number
  type: string
  snippet: string
  updatedAt: number
}

/** Result of one incremental synchronisation pass. */
export interface SyncResult {
  indexed: number
  removed: number
  pending: number
}

const DEFAULT_MAX_TEXT = 2000
const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, size INTEGER NOT NULL, mtime_ns TEXT NOT NULL, indexed_at INTEGER NOT NULL, doc_count INTEGER NOT NULL)',
  "CREATE VIRTUAL TABLE IF NOT EXISTS docs USING fts5(text, session_id UNINDEXED, seq UNINDEXED, type UNINDEXED, time UNINDEXED, tokenize = 'unicode61')"
]

/** Default on-disk location for the plugin-owned index. */
export function defaultIndexPath(): string {
  return join(homedir(), '.dsh/storages/session-fleet-search.sqlite')
}

/** Locate session logs under the standard DSH session root. */
function collectSources(root: string): SessionSource[] {
  const sources: SessionSource[] = []
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return sources
  }
  for (const slug of slugs) {
    const slugDir = join(root, slug)
    let names: string[]
    try {
      names = readdirSync(slugDir)
    } catch {
      continue
    }
    for (const name of names) {
      const path = join(slugDir, name, 'session.v4.jsonl.zstd')
      try {
        const stat = statSync(path, { bigint: true })
        if (!stat.isFile()) continue
        sources.push({ path, size: Number(stat.size), mtimeNs: stat.mtimeNs })
      } catch {
        continue
      }
    }
  }
  return sources
}

/** Join the text blocks of one content array, dropping reasoning and structure. */
function contentText(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const record = block as Record<string, unknown>
    if (record.type === 'text' && typeof record.text === 'string') parts.push(record.text)
    else if (record.type === 'tool-call') parts.push(String(record.name ?? ''), String(record.arguments ?? ''))
  }
  return parts
    .map(part => part.trim())
    .filter(part => part.length > 0)
    .join('\n')
}

/** Extract searchable text from one raw session event. */
function eventText(event: Record<string, unknown>): string {
  const data = (event.data ?? {}) as Record<string, unknown>
  switch (event.type) {
    case 'user/message':
      return contentText(data.content)
    case 'assistant/message': {
      const message = (data.message ?? {}) as Record<string, unknown>
      return contentText(message.content)
    }
    case 'tool/result': {
      const message = (data.message ?? {}) as Record<string, unknown>
      return contentText(message.content)
    }
    case 'todo/write': {
      const todos = Array.isArray(data.todos) ? data.todos : []
      return todos
        .map(todo => {
          const record = (todo ?? {}) as Record<string, unknown>
          return String(record.status ?? '') + ' ' + String(record.content ?? '')
        })
        .join('\n')
        .trim()
    }
    default:
      return ''
  }
}

/** Parse one session log into header identity plus searchable documents. */
export function readSessionLog(path: string): { id: string; createdAt: number; documents: IndexedDocument[] } {
  const decoded = spawnSync('zstd', ['-dc', path], { maxBuffer: 1024 * 1024 * 1024 })
  if (decoded.error !== undefined) throw decoded.error
  if (decoded.status !== 0) throw new Error('zstd failed for ' + path + ': ' + decoded.stderr.toString('utf8').slice(0, 200))
  const raw = decoded.stdout.toString('utf8')
  let id = ''
  let createdAt = 0
  const documents: IndexedDocument[] = []
  for (const line of raw.split('\n')) {
    if (line.length === 0) continue
    let event: Record<string, unknown>
    try {
      event = JSON.parse(line) as Record<string, unknown>
    } catch {
      continue
    }
    if (event.type === 'session') {
      id = String(event.id ?? '')
      createdAt = Number(event.createdAt ?? 0)
      continue
    }
    const text = eventText(event).slice(0, DEFAULT_MAX_TEXT)
    if (text.length === 0) continue
    documents.push({ seq: Number(event.seq ?? 0), type: String(event.type ?? ''), time: Number(event.time ?? 0), text })
  }
  if (id.length === 0) throw new Error('session log has no header: ' + path)
  return { id, createdAt, documents }
}

/** Quote one literal term for FTS5. */
function quoteTerm(term: string): string {
  return '"' + term.replaceAll('"', '""') + '"'
}

/** Owns the SQLite database that backs search_sessions. */
export class SessionSearchIndex {
  readonly path: string
  readonly sessionRoot: string

  constructor(path: string = defaultIndexPath(), sessionRoot: string = join(homedir(), '.dsh/sessions')) {
    this.path = path
    this.sessionRoot = sessionRoot
  }

  /** Open the database, creating the schema on first use. */
  private open(): DatabaseSync {
    mkdirSync(dirname(this.path), { recursive: true })
    const db = new DatabaseSync(this.path)
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
    db.exec('PRAGMA busy_timeout = 5000')
    db.exec('PRAGMA cache_size = -65536')
    for (const statement of SCHEMA) db.exec(statement)
    return db
  }

  /**
   * Bring the index up to date within a bounded budget.
   * @returns how many sessions were indexed or removed, and how many remain.
   */
  sync(options: SyncOptions = {}): SyncResult {
    const db = this.open()
    try {
      const maxSessions = options.maxSessions ?? 50
      const budgetMs = options.budgetMs ?? 3000
      const deadline = Date.now() + budgetMs
      const rows = db.prepare('SELECT path, size, mtime_ns FROM sessions').all() as Array<{ path: string; size: number; mtime_ns: string }>
      const known = new Map(rows.map(row => [row.path, row]))
      const sources = collectSources(this.sessionRoot)
      const live = new Set(sources.map(source => source.path))
      let removed = 0
      for (const [path] of known) {
        if (live.has(path)) continue
        const id = db.prepare('SELECT id FROM sessions WHERE path = ?').get(path) as { id: string } | undefined
        if (id === undefined) continue
        db.exec('BEGIN IMMEDIATE')
        db.prepare('DELETE FROM docs WHERE session_id = ?').run(id.id)
        db.prepare('DELETE FROM sessions WHERE path = ?').run(path)
        db.exec('COMMIT')
        removed += 1
      }
      const changed = sources
        .filter(source => {
          const row = known.get(source.path)
          return row === undefined || row.size !== source.size || row.mtime_ns !== source.mtimeNs.toString()
        })
        .sort((a, b) => (a.mtimeNs > b.mtimeNs ? -1 : 1))
      let indexed = 0
      for (const source of changed) {
        if (indexed >= maxSessions || Date.now() > deadline) break
        const { id, documents } = readSessionLog(source.path)
        const insertDoc = db.prepare('INSERT INTO docs (text, session_id, seq, type, time) VALUES (?, ?, ?, ?, ?)')
        db.exec('BEGIN IMMEDIATE')
        try {
          db.prepare('DELETE FROM docs WHERE session_id = ?').run(id)
          for (const document of documents) insertDoc.run(document.text, id, document.seq, document.type, document.time)
          db.prepare('INSERT OR REPLACE INTO sessions (id, path, size, mtime_ns, indexed_at, doc_count) VALUES (?, ?, ?, ?, ?, ?)').run(
            id,
            source.path,
            source.size,
            source.mtimeNs.toString(),
            Date.now(),
            documents.length
          )
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
        indexed += 1
      }
      return { indexed, removed, pending: Math.max(0, changed.length - indexed) }
    } finally {
      db.close()
    }
  }

  /** Run one FTS5 query and return deduplicated session hits. */
  search(query: string, options: { limit?: number; cwd?: string } = {}): { hits: SearchHit[]; totalMatches: number } {
    const terms = query
      .trim()
      .split(/\s+/)
      .filter(term => term.length > 0)
      .slice(0, 8)
    if (terms.length === 0) throw new Error('query must contain at least one term')
    const limit = options.limit ?? 10
    const match = terms.map(quoteTerm).join(' ')
    if (!existsSync(this.path)) return { hits: [], totalMatches: 0 }
    const db = new DatabaseSync(this.path, { readOnly: true })
    try {
      const rows = db
        .prepare(
          "SELECT s.id AS sessionId, s.indexed_at AS updatedAt, docs.seq AS seq, docs.type AS type, snippet(docs, 0, '[', ']', '…', 16) AS snippet " +
            'FROM docs JOIN sessions s ON s.id = docs.session_id WHERE docs MATCH ? ORDER BY rank LIMIT ?'
        )
        .all(match, limit * 6) as Array<{ sessionId: string; updatedAt: number; seq: number; type: string; snippet: string }>
      const hits: SearchHit[] = []
      const seen = new Set<string>()
      for (const row of rows) {
        if (seen.has(row.sessionId)) continue
        seen.add(row.sessionId)
        hits.push({ sessionId: row.sessionId, seq: Number(row.seq), type: row.type, snippet: row.snippet, updatedAt: row.updatedAt })
        if (hits.length >= limit) break
      }
      const total = (db.prepare('SELECT count(*) AS c FROM docs WHERE docs MATCH ?').get(match) as { c: number }).c
      return { hits, totalMatches: Number(total) }
    } finally {
      db.close()
    }
  }
}
