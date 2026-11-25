import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const toBlob = vi.fn()
vi.mock('write-excel-file/browser', () => ({ default: vi.fn(() => ({ toBlob })) }))
vi.mock('./downloadBlob', () => ({ downloadBlob: vi.fn() }))

import writeExcelFile from 'write-excel-file/browser'
import { downloadBlob } from './downloadBlob'
import { EXCEL_TIMEOUT_MESSAGE, EXCEL_TIME_LIMIT_MS, saveExcelFile } from './saveExcelFile'

beforeEach(() => {
  vi.useFakeTimers()
  vi.clearAllMocks()
})
afterEach(() => vi.useRealTimers())

describe('saveExcelFile', () => {
  it('builds the file with the given options and saves it under the given name', async () => {
    const blob = { size: 10 }
    toBlob.mockResolvedValue(blob)

    await saveExcelFile(['sheet'], { fontSize: 11 }, 'report.xlsx')

    expect(writeExcelFile).toHaveBeenCalledWith(['sheet'], { fontSize: 11 })
    expect(downloadBlob).toHaveBeenCalledWith(blob, 'report.xlsx')
    expect(vi.getTimerCount()).toBe(0)
  })

  it('stops waiting after the time limit, and does not save a file that arrives late', async () => {
    let finish
    toBlob.mockReturnValue(new Promise((done) => { finish = done }))

    const saving = expect(saveExcelFile([], {}, 'late.xlsx')).rejects.toThrow(EXCEL_TIMEOUT_MESSAGE)
    await vi.advanceTimersByTimeAsync(EXCEL_TIME_LIMIT_MS)
    await saving

    finish({ size: 10 })
    await vi.advanceTimersByTimeAsync(0)
    expect(downloadBlob).not.toHaveBeenCalled()
  })

  it('passes on an error from building the file', async () => {
    toBlob.mockRejectedValue(new Error('Disk is full'))

    await expect(saveExcelFile([], {}, 'x.xlsx')).rejects.toThrow('Disk is full')
    expect(downloadBlob).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })
})

describe('site security rule', () => {
  const policy = JSON.parse(readFileSync(resolve(process.cwd(), 'vercel.json'), 'utf8'))
    .headers.flatMap((entry) => entry.headers)
    .find((header) => header.key === 'Content-Security-Policy').value
  const directives = Object.fromEntries(
    policy.split(';').map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values])
  )

  it('lets the Excel compression worker start', () => {
    expect(directives['worker-src']).toEqual(["'self'", 'blob:'])
  })

  it('still limits ordinary scripts to the site itself', () => {
    expect(directives['script-src']).toEqual(["'self'"])
    expect(directives['default-src']).toEqual(["'self'"])
  })
})
