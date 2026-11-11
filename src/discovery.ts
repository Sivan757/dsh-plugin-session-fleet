/** Snapshot cursors for the Host-authorized session list. */
import { createHash } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import type { SessionSummary } from '@deepseek-ai/dsh-api-session-controller/types'

const listCursor = z.object({ version: z.const(1).required(), fingerprint: z.string().required(), offset: z.natural().max(Number.MAX_SAFE_INTEGER).required() })

/** Slice one stable authorized listing; a changed query or corpus invalidates its cursor. */
export function sessionListPage(rows: readonly SessionSummary[], limit: number, scope: string | undefined, cursor?: string) {
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
