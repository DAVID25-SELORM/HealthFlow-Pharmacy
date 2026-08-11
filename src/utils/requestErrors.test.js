import { getErrorMessage, isNetworkRequestError } from './requestErrors'

describe('request error utilities', () => {
  it('detects browser fetch/network failures', () => {
    expect(isNetworkRequestError(new TypeError('Failed to fetch'))).toBe(true)
    expect(isNetworkRequestError(new Error('NetworkError when attempting to fetch resource.'))).toBe(true)
    expect(isNetworkRequestError({ name: 'AbortError', message: 'The operation was aborted.' })).toBe(true)
  })

  it('leaves validation errors as non-network errors', () => {
    expect(isNetworkRequestError(new Error('Patient address is required.'))).toBe(false)
  })

  it('returns a fallback when an error has no message', () => {
    expect(getErrorMessage({}, 'Unable to submit claim.')).toBe('Unable to submit claim.')
  })

  it('extracts nested Edge Function errors instead of showing object text', () => {
    expect(getErrorMessage({
      error: { message: 'Report query is too large.' },
    })).toBe('Report query is too large.')
    expect(getErrorMessage({
      message: { details: 'PostgREST rejected the report query.' },
    })).toBe('PostgREST rejected the report query.')
  })
})
