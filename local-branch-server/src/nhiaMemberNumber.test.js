import { expect, it } from 'vitest'
import { getGhanaCardPrefix, isGhanaCardNumber } from './nhiaMemberNumber.js'

it('recognises GHA and foreign national country-code Ghana Cards', () => {
  expect(getGhanaCardPrefix('GHA-123456789-0')).toBe('GHA')
  expect(getGhanaCardPrefix('swz-7297126385')).toBe('SWZ')
  expect(getGhanaCardPrefix('KEN 7292382520')).toBe('KEN')
  expect(isGhanaCardNumber('KEN-729238252-0')).toBe(true)
})

it('does not treat NHIS numbers, typos or empty values as Ghana Cards', () => {
  expect(isGhanaCardNumber('12345678')).toBe(false)
  expect(isGhanaCardNumber('GAH-123456789-0')).toBe(false)
  expect(isGhanaCardNumber('NHIS12345678')).toBe(false)
  expect(isGhanaCardNumber('')).toBe(false)
  expect(isGhanaCardNumber(undefined)).toBe(false)
})
