import { describe, expect, it } from 'vitest'
import { isPersistedPatientUuid } from './patientWorkspace'

describe('patient workspace identifiers', () => {
  it('allows persisted patient UUIDs in UUID database filters', () => {
    expect(isPersistedPatientUuid('391c50f7-4e6d-4cce-8046-39b1bf388a6b')).toBe(true)
  })

  it('rejects synthetic NHIS-only patient identifiers', () => {
    expect(isPersistedPatientUuid(
      'nhis-claim-391c50f7-4e6d-4cce-8046-39b1bf388a6b',
    )).toBe(false)
  })
})
