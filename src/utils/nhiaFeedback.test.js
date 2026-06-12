import { describe, expect, it } from 'vitest'
import {
  getNhiaMemberFeedbackMessage,
  INACTIVE_NHIS_MEMBER_MESSAGE,
} from './nhiaFeedback'

describe('NHIA member feedback', () => {
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
