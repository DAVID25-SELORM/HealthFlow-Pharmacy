import { describe, expect, it } from 'vitest'
import {
  formatDiagnosisDetails,
  formatDiagnosisText,
  getDiagnosisSelections,
} from './diagnosisCatalogService'

describe('diagnosisCatalogService', () => {
  it('keeps structured diagnosis code, label, and source metadata', () => {
    const details = formatDiagnosisDetails([
      {
        code: 'A009',
        label: 'Cholera, unspecified',
        source: 'ICD-10',
        sourceVersion: 'ICD-10-CSV-master',
      },
    ])

    expect(details).toEqual([
      {
        code: 'A009',
        label: 'Cholera, unspecified',
        source: 'ICD-10',
        sourceVersion: 'ICD-10-CSV-master',
        custom: false,
      },
    ])
    expect(formatDiagnosisText(details)).toBe('Cholera, unspecified')
  })

  it('treats legacy text diagnoses as custom entries without splitting commas', () => {
    const diagnoses = getDiagnosisSelections('Cholera, unspecified\nMalaria', [])

    expect(diagnoses).toEqual([
      expect.objectContaining({
        label: 'Cholera, unspecified',
        source: 'Custom',
      }),
      expect.objectContaining({
        label: 'Malaria',
        source: 'Custom',
      }),
    ])
  })
})
