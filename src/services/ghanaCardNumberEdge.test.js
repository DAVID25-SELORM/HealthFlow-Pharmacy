// @vitest-environment node
import { describe, expect, it } from 'vitest'
import {
  GHANA_CARD_COUNTRY_PREFIXES,
  isCanonicalGhanaCardNumber,
  isGhanaCardNumber,
} from '../../supabase/functions/_shared/ghanaCardNumber.ts'
import { prepareNehfamsAttendance } from '../../supabase/functions/_shared/nehfamsAdapter.ts'
import { runCccRequest } from '../../supabase/functions/_shared/cccProvider.ts'
import { GHANA_CARD_COUNTRY_PREFIXES as WEB_PREFIXES } from '../utils/nhiaMemberNumber'
import { GHANA_CARD_COUNTRY_PREFIXES as LOCAL_SERVER_PREFIXES } from '../../local-branch-server/src/nhiaMemberNumber.js'

const facility = { hpn: 'test', name: 'Test Facility', authMode: '1FA', otacRequired: false }
const nehfams = (cardNo) => ({
  environment: 'test', apiKey: 'synthetic-key', apiSecret: 'synthetic-secret',
  cardType: 'GHANACARD', cardNo, facility,
})

describe('edge function Ghana Card number rules', () => {
  it('accepts GHA and foreign national country-code cards in canonical form', () => {
    for (const card of ['GHA-123456789-0', 'SWZ-729712638-5', 'KEN-729238252-0']) {
      expect(isCanonicalGhanaCardNumber(card)).toBe(true)
      expect(isGhanaCardNumber(card)).toBe(true)
    }
  })

  it('rejects typo prefixes, wrong digit counts and non-canonical text', () => {
    for (const card of ['GAH-123456789-0', 'KXN-729238252-0', 'KEN-72923825-0', 'KEN-7292382520', 'KEN 7292382520', '12345678', '', null, undefined]) {
      expect(isCanonicalGhanaCardNumber(card)).toBe(false)
    }
  })

  it('lenient form tolerates case and surrounding spaces, canonical form does not', () => {
    expect(isGhanaCardNumber('  ken-729238252-0 ')).toBe(true)
    expect(isCanonicalGhanaCardNumber('ken-729238252-0')).toBe(false)
  })

  it('uses the same country list as the web app and the branch server', () => {
    expect(GHANA_CARD_COUNTRY_PREFIXES.size).toBe(249)
    expect([...GHANA_CARD_COUNTRY_PREFIXES].sort()).toEqual([...WEB_PREFIXES].sort())
    expect([...GHANA_CARD_COUNTRY_PREFIXES].sort()).toEqual([...LOCAL_SERVER_PREFIXES].sort())
  })
})

describe('NeHFAMS request preparation', () => {
  it('sends a foreign national card as a Ghana Card', () => {
    const request = prepareNehfamsAttendance(nehfams('KEN-729238252-0'))
    expect(JSON.parse(request.body)).toEqual({ CardType: 'GHANACARD', CardNo: 'KEN-729238252-0' })
  })

  it('still sends GHA cards and rejects an unknown prefix', () => {
    expect(JSON.parse(prepareNehfamsAttendance(nehfams('GHA-123456789-0')).body).CardNo).toBe('GHA-123456789-0')
    expect(() => prepareNehfamsAttendance(nehfams('KXN-729238252-0'))).toThrow(/Invalid NeHFAMS card number/)
  })
})

describe('CCC request validation', () => {
  const run = (memberNumber, cardType) => runCccRequest({ db: {}, org: 'o', actor: {}, branch: {}, payload: { memberNumber, cardType } })

  it('rejects an unknown prefix before any provider work', async () => {
    await expect(run('KXN-729238252-0')).rejects.toThrow('Enter a valid membership number and card type')
    await expect(run('KEN-72923825-0', 'GHANACARD')).rejects.toThrow('Enter a valid membership number and card type')
  })

  it('lets a foreign national card past the format check', async () => {
    // db is a stub, so the request fails later (policy lookup) - just not on the card format.
    await expect(run('SWZ-729712638-5')).rejects.not.toThrow('Enter a valid membership number and card type')
  })
})
