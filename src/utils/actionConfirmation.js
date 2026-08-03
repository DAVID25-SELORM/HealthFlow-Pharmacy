import { buildActionConfirmation, requestAppConfirmation } from './appDialog'

export { buildActionConfirmation }

export const confirmAction = (options) => requestAppConfirmation(options)
