const hasValue = (value) =>
  value !== null && value !== undefined && String(value).trim() !== ''

export const buildActionConfirmation = ({
  title,
  details = [],
  warning = '',
  confirmText = 'continue',
}) => {
  const lines = details
    .filter((detail) => detail && hasValue(detail.value))
    .map((detail) => `• ${detail.label}: ${detail.value}`)

  return [
    title,
    lines.length ? `Review before continuing:\n${lines.join('\n')}` : '',
    warning,
    `Select OK to ${confirmText}.`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export const confirmAction = (options) =>
  window.confirm(buildActionConfirmation(options))
