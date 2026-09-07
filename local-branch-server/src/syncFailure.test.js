import { describe, expect, it } from 'vitest'
import { FAILURE_CATEGORIES, classifySyncFailure, nextRetryAt } from './syncFailure.js'

describe('sync failure classification', () => {
  it('pauses authentication failures and requires manual action for invalid writes', () => {
    expect(classifySyncFailure(new Error('JWT expired')).category).toBe(FAILURE_CATEGORIES.AUTH)
    expect(classifySyncFailure(new Error('Invalid sale payload')).category).toBe(FAILURE_CATEGORIES.VALIDATION)
    expect(classifySyncFailure(new Error('duplicate key value violates unique constraint')).category).toBe(FAILURE_CATEGORIES.CONFLICT)
  })

  it('uses bounded retry intervals for transient failures', () => {
    expect(nextRetryAt(1, 0)).toBe('1970-01-01T00:00:30.000Z')
    expect(nextRetryAt(99, 0)).toBe('1970-01-01T00:30:00.000Z')
  })
})
