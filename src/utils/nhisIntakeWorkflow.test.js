import { describe, expect, it } from 'vitest'
import {
  canSaveNhisIncompleteIntake,
  getNhisIncompleteIntakeItems,
  hasNhisPrescriptionAttachment,
} from './nhisIntakeWorkflow'

describe('NHIS dispensary intake workflow', () => {
  it('allows a claims officer to dispatch all four medicine/attachment combinations', () => {
    expect(getNhisIncompleteIntakeItems()).toEqual(['medicines', 'prescription attachment'])
    expect(getNhisIncompleteIntakeItems({
      medicines: [{ id: 'medicine-1' }],
    })).toEqual(['prescription attachment'])
    expect(getNhisIncompleteIntakeItems({
      claim: { prescriptionFilePath: 'rx/file.pdf' },
    })).toEqual(['medicines'])
    expect(getNhisIncompleteIntakeItems({
      claim: { prescriptionFilePath: 'rx/file.pdf' },
      medicines: [{ id: 'medicine-1' }],
    })).toEqual([])
  })

  it('recognizes pending uploads and existing attachment formats', () => {
    expect(hasNhisPrescriptionAttachment({}, { name: 'rx.pdf' })).toBe(true)
    expect(hasNhisPrescriptionAttachment({ prescription_file_url: 'https://example.test/rx' })).toBe(true)
    expect(hasNhisPrescriptionAttachment({ claimit_attachment_base64: 'JVBERi0=' })).toBe(true)
  })

  it('treats a pharmacy claim without an attachment as incomplete', () => {
    expect(hasNhisPrescriptionAttachment({ status: 'served' })).toBe(false)
    expect(hasNhisPrescriptionAttachment({
      status: 'served',
      prescription_file_path: 'rx/claim.pdf',
    })).toBe(true)
  })

  it('permits incomplete claims-staff saves without weakening MCA or final review checks', () => {
    expect(canSaveNhisIncompleteIntake({ isEditing: false, blockerCount: 5 })).toBe(true)
    expect(canSaveNhisIncompleteIntake({
      isEditing: true,
      status: 'pending_serving',
      blockerCount: 5,
    })).toBe(true)
    expect(canSaveNhisIncompleteIntake({
      isEditing: true,
      status: 'returned_for_review',
      blockerCount: 2,
    })).toBe(true)
    expect(canSaveNhisIncompleteIntake({
      isEditing: true,
      status: 'returned_for_review',
      blockerCount: 0,
    })).toBe(false)
    expect(canSaveNhisIncompleteIntake({
      isMedicineCounterAssistant: true,
      status: 'pending_serving',
      blockerCount: 5,
    })).toBe(false)
  })
})
