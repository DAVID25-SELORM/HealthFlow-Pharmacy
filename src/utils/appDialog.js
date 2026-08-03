const hasValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== ''

export const buildActionConfirmation = ({
  title,
  details = [],
  warning = '',
  confirmText = 'continue',
}) => ({
  title,
  details: details.filter((detail) => detail && hasValue(detail.value)),
  warning,
  confirmText,
})

const requestAppDialog = (payload) =>
  new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve(payload.type === 'prompt' ? null : false)
      return
    }

    let handled = false
    const event = new CustomEvent('healthflow:app-dialog', {
      detail: {
        ...payload,
        markHandled: () => {
          handled = true
        },
        resolve,
      },
    })
    window.dispatchEvent(event)
    if (!handled) {
      resolve(payload.type === 'prompt' ? null : false)
    }
  })

export const requestAppConfirmation = (options) =>
  requestAppDialog({
    type: 'confirm',
    ...buildActionConfirmation(options),
  })

export const requestAppPrompt = ({
  title,
  message = '',
  defaultValue = '',
  placeholder = '',
  label = 'Response',
  confirmText = 'Continue',
  cancelText = 'Cancel',
  required = false,
  multiline = false,
  details = [],
  warning = '',
}) =>
  requestAppDialog({
    type: 'prompt',
    title,
    message,
    defaultValue,
    placeholder,
    label,
    confirmText,
    cancelText,
    required,
    multiline,
    details: details.filter((detail) => detail && hasValue(detail.value)),
    warning,
  })
