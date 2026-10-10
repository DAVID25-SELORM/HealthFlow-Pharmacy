// @vitest-environment node
import { describe, expect, it } from 'vitest'
import { normalizeAttendanceNewCcc, normalizeAttendanceVerification } from './nhiaAttendanceValues'
describe('NHIA attendance form values', () => {
  it.each([[false, 'no'], [true, 'yes'], ['NO', 'no'], ['YES', 'yes'], [0, 'no'], [1, 'yes'], [null, ''], [undefined, '']])('maps %s to a dropdown value', (input, expected) => {
    expect(normalizeAttendanceNewCcc(input)).toBe(expected)
  })
  it('supports cached verified responses and current confirmed responses', () => {
    expect(normalizeAttendanceVerification('verified')).toBe('confirmed')
    expect(normalizeAttendanceVerification('confirmed')).toBe('confirmed')
    expect(normalizeAttendanceVerification(undefined)).toBe('')
  })
})
