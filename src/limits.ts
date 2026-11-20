/** Fixed limits the tools apply without exposing them as configuration. */

/** Upper bound of one send_to_session message body in UTF-16 code units. */
export const MAX_MESSAGE_CHARS = 20_000

/** Caps for model-facing transcript exports. */
export const TRANSCRIPT_LIMITS = {
  maxBytes: 8 * 1024 * 1024,
  maxFiles: 20,
  ttlSeconds: 3600,
  chunkChars: 1024
} as const

/** Work one search_sessions call may spend keeping its index current. */
export const SEARCH_SYNC = {
  maxSessions: 50,
  budgetMs: 3000
} as const
