/** Snapshot cursors for the Host-authorized session list. */

/** Validate a literal query shared by title and event discovery. */
export function literalQuery(value: string): string {
  const query = value.trim()
  if (query.length === 0 || query.length > 500) throw new Error('query must contain 1 through 500 UTF-16 code units')
  return query
}
