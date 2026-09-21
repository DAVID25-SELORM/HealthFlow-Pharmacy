// @vitest-environment jsdom
// Every NHIA setting must be identifiable by a visible label, not only a placeholder.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import NhiaAccreditationDatesFields from '../components/NhiaAccreditationDatesFields'

const source = readFileSync('src/pages/Settings.jsx', 'utf8').replace(/\r\n/g, '\n')
const form = source.slice(
  source.indexOf('<form className="settings-form" onSubmit={handleSaveNhiaApi}>'),
  source.indexOf('</form>', source.indexOf('onSubmit={handleSaveNhiaApi}')),
)

describe('NHIA settings form labelling', () => {
  it('has no bare input or select outside a labelled settings-field', () => {
    const lines = form.split('\n')
    const bare = []
    let depth = 0
    lines.forEach((line, index) => {
      const t = line.trim()
      if (t.startsWith('<label className="settings-field">')) depth += 1
      if ((t === '<input' || t === '<select') && depth === 0) {
        const block = lines.slice(index, index + 12).join('\n')
        if (!/type="(checkbox|file)"/.test(block)) bare.push(index + 1)
      }
      if (t === '</label>') depth = Math.max(0, depth - 1)
    })
    expect(bare).toEqual([])
  })

  it('uses the labelled accreditation dates component instead of bare date inputs', () => {
    expect(form).toContain('<NhiaAccreditationDatesFields')
    expect(form).not.toContain('type="date"')
  })

  it('names the key NHIA identifiers', () => {
    for (const label of ['NeHFAMS HPN', 'NeHFAMS HP Code', 'CLAIM-it credential code', 'Provider level code', 'License number', 'Facility code', 'Claims officer name']) {
      expect(form).toContain(`<span>${label}`)
    }
  })
})

describe('NhiaAccreditationDatesFields', () => {
  it('shows the three dates with distinct visible labels and never edits one from another', () => {
    const changes = []
    render(
      <NhiaAccreditationDatesFields
        credentialCode="A-B-C-D-E-F-G-H-011225-X"
        generatedDate="2027-08-01"
        expiryDate="2027-08-01"
        requireGenerated
        onChange={(field, value) => changes.push([field, value])}
      />,
    )
    expect(screen.getByText('Accreditation Effective Date')).toBeTruthy()
    const generated = screen.getByLabelText('Accreditation Generated / Issue Date')
    const expiry = screen.getByLabelText('Accreditation Expiry Date')
    fireEvent.change(generated, { target: { value: '2025-12-29' } })
    expect(changes).toEqual([['accreditationDateGenerated', '2025-12-29']])
    expect(expiry.value).toBe('2027-08-01')
  })
})
