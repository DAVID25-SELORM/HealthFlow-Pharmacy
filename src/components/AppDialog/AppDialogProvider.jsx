import { useEffect, useState } from 'react'
import { AlertTriangle, X } from 'lucide-react'
import './AppDialogProvider.css'

const blankDialog = null

const AppDialogProvider = ({ children }) => {
  const [dialog, setDialog] = useState(blankDialog)
  const [inputValue, setInputValue] = useState('')

  useEffect(() => {
    const handleDialogRequest = (event) => {
      const nextDialog = event.detail
      nextDialog.markHandled?.()
      setDialog(nextDialog)
      setInputValue(String(nextDialog.defaultValue ?? ''))
    }

    window.addEventListener('healthflow:app-dialog', handleDialogRequest)
    return () => window.removeEventListener('healthflow:app-dialog', handleDialogRequest)
  }, [])

  const closeDialog = (value) => {
    const resolver = dialog?.resolve
    setDialog(blankDialog)
    setInputValue('')
    if (resolver) resolver(value)
  }

  const confirm = () => {
    if (!dialog) return
    if (dialog.type === 'prompt') {
      if (dialog.required && !inputValue.trim()) return
      closeDialog(inputValue)
      return
    }
    closeDialog(true)
  }

  const cancel = () => closeDialog(dialog?.type === 'prompt' ? null : false)

  return (
    <>
      {children}
      {dialog && (
        <div className="app-dialog-overlay" role="presentation">
          <section
            className={`app-dialog app-dialog--${dialog.type}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-dialog-title"
          >
            <header className="app-dialog__header">
              <div className="app-dialog__title-group">
                {dialog.warning && (
                  <span className="app-dialog__icon" aria-hidden="true">
                    <AlertTriangle size={18} />
                  </span>
                )}
                <h2 id="app-dialog-title">{dialog.title || 'Confirm action'}</h2>
              </div>
              <button type="button" className="app-dialog__close" onClick={cancel} aria-label="Close dialog">
                <X size={18} />
              </button>
            </header>

            <div className="app-dialog__body">
              {dialog.message && <p className="app-dialog__message">{dialog.message}</p>}

              {dialog.details?.length > 0 && (
                <dl className="app-dialog__details">
                  {dialog.details.map((detail, index) => (
                    <div key={`${detail.label}-${index}`}>
                      <dt>{detail.label}</dt>
                      <dd>{detail.value}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {dialog.warning && <p className="app-dialog__warning">{dialog.warning}</p>}

              {dialog.type === 'prompt' && (
                <label className="app-dialog__field">
                  <span>{dialog.label || 'Response'}</span>
                  {dialog.multiline ? (
                    <textarea
                      value={inputValue}
                      placeholder={dialog.placeholder}
                      onChange={(event) => setInputValue(event.target.value)}
                      rows={4}
                      autoFocus
                    />
                  ) : (
                    <input
                      value={inputValue}
                      placeholder={dialog.placeholder}
                      onChange={(event) => setInputValue(event.target.value)}
                      autoFocus
                    />
                  )}
                </label>
              )}
            </div>

            <footer className="app-dialog__footer">
              <button type="button" className="btn btn-outline" onClick={cancel}>
                {dialog.cancelText || 'Cancel'}
              </button>
              <button
                type="button"
                className="btn btn-primary"
                onClick={confirm}
                disabled={dialog.type === 'prompt' && dialog.required && !inputValue.trim()}
              >
                {dialog.confirmText || 'Continue'}
              </button>
            </footer>
          </section>
        </div>
      )}
    </>
  )
}

export default AppDialogProvider
