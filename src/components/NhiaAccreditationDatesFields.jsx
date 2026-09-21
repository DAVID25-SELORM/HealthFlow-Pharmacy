import { useId } from 'react'
import {
  ACCREDITATION_GENERATED_HELPER_TEXT,
  getAccreditationDateIssues,
  getAccreditationEffectiveDateFromCredentialCode,
  setAccreditationEffectiveDateInCredentialCode,
} from '../utils/nhiaAccreditationDates'

// The three accreditation dates, each with a visible label. They are independent:
// nothing here copies or derives one from another, and warnings never edit a value.
// Effective date is derived from the credential code and is display-only.
export default function NhiaAccreditationDatesFields({
  credentialCode = '',
  generatedDate = '',
  expiryDate = '',
  onChange,
  onCredentialCodeChange,
  requireGenerated = false,
  disabled = false,
}) {
  const id = useId()
  const effectiveDate = getAccreditationEffectiveDateFromCredentialCode(credentialCode)
  const canEditEffective = String(credentialCode || '').trim().split('-').length >= 9
  const issues = getAccreditationDateIssues({
    generated: generatedDate, expiry: expiryDate, effective: effectiveDate, requireGenerated,
  })
  const generatedIssues = issues.filter((issue) => issue.field === 'generated')
  const expiryIssues = issues.filter((issue) => issue.field === 'expiry')
  const renderIssues = (list) => list.map((issue) => (
    <p key={issue.code} className="settings-helper" role={issue.code.endsWith('_INVALID') ? 'alert' : 'status'} data-issue={issue.code}>
      {issue.severity === 'warning' ? 'Warning: ' : ''}{issue.message}
    </p>
  ))

  return (
    <div
      className="settings-form-row"
      data-testid="nhia-accreditation-dates"
      style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(14rem, 1fr))', gap: '0.75rem' }}
    >
      <div className="settings-field">
        <label htmlFor={`${id}-effective`}><span>Accreditation Effective Date</span></label>
        <input
          id={`${id}-effective`}
          type="date"
          data-testid="accreditation-effective-date"
          value={effectiveDate}
          disabled={disabled || !canEditEffective}
          aria-describedby={`${id}-effective-help`}
          onChange={(event) => {
            const next = setAccreditationEffectiveDateInCredentialCode(credentialCode, event.target.value)
            if (next) onCredentialCodeChange?.(next)
          }}
        />
        <p id={`${id}-effective-help`} className="settings-helper">
          {canEditEffective
            ? 'Pick the date to update it. This changes the date segment of the CLAIM-it credential code above, which is where the effective date is stored.'
            : 'Enter the full CLAIM-it credential code above first; the effective date is stored inside it.'}
        </p>
      </div>
      <div className="settings-field">
        <label htmlFor={`${id}-generated`}><span>Accreditation Generated / Issue Date</span></label>
        <input
          id={`${id}-generated`}
          type="date"
          value={generatedDate}
          disabled={disabled}
          aria-describedby={`${id}-generated-help`}
          onChange={(event) => onChange?.('accreditationDateGenerated', event.target.value)}
        />
        <p id={`${id}-generated-help`} className="settings-helper">{ACCREDITATION_GENERATED_HELPER_TEXT}</p>
        {renderIssues(generatedIssues)}
      </div>
      <div className="settings-field">
        <label htmlFor={`${id}-expiry`}><span>Accreditation Expiry Date</span></label>
        <input
          id={`${id}-expiry`}
          type="date"
          value={expiryDate}
          disabled={disabled}
          onChange={(event) => onChange?.('accreditationExpiryDate', event.target.value)}
        />
        {renderIssues(expiryIssues)}
      </div>
    </div>
  )
}
