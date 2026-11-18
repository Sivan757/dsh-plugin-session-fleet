import { describe, expect, it } from 'vitest'
import { literalQuery } from '../src/discovery.ts'

describe('literal query validation', () => {
  it('trims the query and rejects empty or oversized values', () => {
    expect(literalQuery('  fleet ')).toBe('fleet')
    expect(() => literalQuery('   ')).toThrow('1 through 500')
    expect(() => literalQuery('x'.repeat(501))).toThrow('1 through 500')
  })
})
