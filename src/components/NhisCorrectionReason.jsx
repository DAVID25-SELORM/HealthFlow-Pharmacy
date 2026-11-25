import { forwardRef, useImperativeHandle, useRef } from 'react'
import { NHIS_REDUCTION_REASONS } from '../utils/nhisServedReductions'
import './NhisCorrectionReason.css'

// The reason box on the claim edit form. Optional for ordinary corrections; when a served
// quantity is lowered it says what changed and offers one-tap reasons.
const NhisCorrectionReason = forwardRef(function NhisCorrectionReason(
  { value, onChange, reductions = [], requiredBySave = false, showMissing = false, isAdmin = true, children },
  ref
) {
  const sectionRef = useRef(null)
  const inputRef = useRef(null)
  useImperativeHandle(ref, () => ({
    show() {
      sectionRef.current?.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
      inputRef.current?.focus({ preventScroll: true })
    },
  }), [])

  const required = reductions.length > 0 || requiredBySave
  const missing = required && showMissing && !value.trim()

  return (
    <section
      ref={sectionRef}
      className={`nhis-section nhis-correction-audit${missing ? ' nhis-correction-audit--missing' : ''}`}
    >
      <h3 className="nhis-section-title" id="nhis-correction-reason-title">
        {required ? 'Why was the quantity lowered? (needed to save)' : 'Reason for correction (optional)'}
      </h3>
      {required && (
        <div className="nhis-reduction">
          {reductions.length > 0 && (
            <ul className="nhis-reduction__list">
              {reductions.map((line) => (
                <li key={line.key}>
                  <strong>{line.description}</strong>: {line.removed ? `removed (was ${line.from})` : `${line.from} → ${line.to}`}
                </li>
              ))}
            </ul>
          )}
          <p>
            If stock was already taken for this claim, saving puts the difference back on the shelf.
            {!isAdmin && ' Only an Admin can save that change.'}
          </p>
          <p>Did not mean to change it? Close without saving.</p>
          <div className="nhis-reduction__choices" role="group" aria-label="Common reasons">
            {NHIS_REDUCTION_REASONS.map((reason) => (
              <button
                key={reason}
                type="button"
                className={`btn btn-sm ${value === reason ? 'btn-primary' : 'btn-secondary'}`}
                aria-pressed={value === reason}
                onClick={() => onChange(reason)}
              >
                {reason}
              </button>
            ))}
          </div>
        </div>
      )}
      {missing && <p className="nhis-reduction__missing">Tap a reason or type one, then save again.</p>}
      <textarea
        ref={inputRef}
        className="form-input"
        rows={required ? 2 : 3}
        aria-labelledby="nhis-correction-reason-title"
        aria-required={required}
        aria-invalid={missing}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={required ? 'Or type another reason' : 'Example: Wrong prescriber entered during initial claim capture.'}
      />
      {children}
    </section>
  )
})

export default NhisCorrectionReason
