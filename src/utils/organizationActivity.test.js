import { describe, expect, it } from 'vitest'
import { formatActiveOrganizationsNotice } from './organizationActivity'

describe('formatActiveOrganizationsNotice', () => {
  it('reports when no organization has recent activity', () => {
    expect(formatActiveOrganizationsNotice([], 15)).toBe(
      'No organizations have recorded activity in the last 15 minutes.'
    )
  })

  it('lists active organizations and summarizes overflow', () => {
    const organizations = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({ name }))
    expect(formatActiveOrganizationsNotice(organizations, 15)).toBe(
      '7 organizations are actively operating: A, B, C, D, E, F and 1 more.'
    )
  })
})
