export const BRANCH_JSON_BODY_LIMIT = '10mb'

export const getBranchRequestErrorResponse = (error = {}) => {
  if (error?.status === 413 || error?.type === 'entity.too.large') {
    return {
      status: 413,
      body: {
        error: 'The request is too large for the local branch server. Prescription attachments must be 3 MB or smaller.',
        code: 'REQUEST_TOO_LARGE',
      },
    }
  }

  const status = error?.status || 400
  const message = String(error?.message || '').trim()

  return {
    status,
    body: {
      error: status >= 500 ? 'Request failed.' : (message || 'Request failed.'),
    },
  }
}
