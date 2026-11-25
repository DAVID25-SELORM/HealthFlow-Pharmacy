// Builds an Excel file and saves it, and never leaves the user waiting for ever.
//
// Large files are compressed in a background worker. If that worker cannot run (for example the
// site's security rule blocks it), the library never reports back, so a time limit is needed.
import writeExcelFile from 'write-excel-file/browser'
import { downloadBlob } from './downloadBlob'

export const EXCEL_TIME_LIMIT_MS = 60_000

export const EXCEL_TIMEOUT_MESSAGE =
  'The Excel file was not ready after a minute. Refresh the page and try again, or choose a shorter period.'

export const saveExcelFile = async (sheets, options, fileName, { timeLimitMs = EXCEL_TIME_LIMIT_MS } = {}) => {
  const building = writeExcelFile(sheets, options).toBlob()
  let timer
  const timeLimit = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(EXCEL_TIMEOUT_MESSAGE)), timeLimitMs)
  })
  try {
    // The file is saved only when it wins the race, so nothing downloads after the error is shown.
    downloadBlob(await Promise.race([building, timeLimit]), fileName)
  } finally {
    clearTimeout(timer)
  }
}
