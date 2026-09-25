import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

// Pins the partial-success wiring on the (very large) NHIS page: a generated CXF whose export record failed is
// never reported as a plain success, and the retry only repairs the record.
const source = readFileSync('src/pages/Nhis.jsx', 'utf8').replace(/\r\n/g, '\n')

describe('CXF export record partial success (NHIS page)', () => {
  it('captures the recording handle from the export warnings and reports partial success instead of success', () => {
    expect(source).toContain('onExportWarnings: (warnings) => {')
    expect(source).toContain('const unrecordedExport = exportRecordingRef.current')
    const partial = source.slice(source.indexOf('if (unrecordedExport) {'))
    expect(partial.slice(0, 700)).toContain('export record could not be fully saved')
    expect(partial.slice(0, 900)).toContain('return')
    expect(source.indexOf('if (unrecordedExport) {')).toBeLessThan(source.indexOf('claims exported as ${selectedFormat.toUpperCase()}'))
  })

  it('offers a retry that only repairs the record, and says the file is not regenerated', () => {
    expect(source).toContain('retryCxfRecording(cxfRecordingIssue)')
    expect(source).toContain('Retry recording')
    expect(source).toContain('does not regenerate the file')
    const retry = source.slice(source.indexOf('const handleRetryCxfRecording'), source.indexOf('const handleExport = async'))
    expect(retry).not.toContain('exportNhisClaimsFile')
    expect(retry).not.toContain('prepareNhisClaimsExport')
  })
})
