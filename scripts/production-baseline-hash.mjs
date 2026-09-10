import { createHash } from 'node:crypto'

// Git can check text out with CRLF on Windows and LF on Linux.
// Preserve all other whitespace and content in the protected fingerprint.
export const hashBaselineSource = (source) =>
  createHash('sha256').update(String(source).replace(/\r\n/g, '\n')).digest('hex')
