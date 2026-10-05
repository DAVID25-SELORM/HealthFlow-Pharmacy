import { describe, expect, it } from 'vitest'
import {
  getNhiaMemberFeedbackMessage,
  INACTIVE_NHIS_MEMBER_MESSAGE,
} from './nhiaFeedback'

describe('NHIA member feedback', () => {
  it('explains an unreachable NHIA host without claiming verification succeeded', () => {
    const message = getNhiaMemberFeedbackMessage('NHIA API request failed: client error (Connect): tcp connect error: No route to host (os error 113)')
    expect(message).toContain('No CC code was generated or verified')
    expect(message).toContain('retry verification later')
    expect(message).not.toContain('os error')
  })
  it('rewords the legacy inactive member lookup response', () => {
    expect(
      getNhiaMemberFeedbackMessage('NHIA member lookup did not return a CC code: INACTIVE.')
    ).toBe(INACTIVE_NHIS_MEMBER_MESSAGE)
  })

  it('rewords inactive member status feedback', () => {
    expect(getNhiaMemberFeedbackMessage('Member status: INACTIVE. Verify eligibility.'))
      .toBe(INACTIVE_NHIS_MEMBER_MESSAGE)
  })

  it('keeps unrelated NHIA errors unchanged', () => {
    expect(getNhiaMemberFeedbackMessage('NHIA request timed out.'))
      .toBe('NHIA request timed out.')
  })
})
