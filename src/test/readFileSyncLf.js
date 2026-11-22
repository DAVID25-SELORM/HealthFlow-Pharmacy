import { readFileSync as readFileSyncRaw } from 'node:fs'

// Source-reading tests compare multi-line snippets written with "\n". Windows
// checkouts save the same files with "\r\n", which made those tests fail on
// Windows only. Reading through this helper gives every machine identical text.
export const readFileSync = (path, options) => {
  const contents = readFileSyncRaw(path, options)
  return typeof contents === 'string' ? contents.replace(/\r\n/g, '\n') : contents
}
