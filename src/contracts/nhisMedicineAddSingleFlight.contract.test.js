import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const nhisPage = readFileSync(resolve(process.cwd(), 'src/pages/Nhis.jsx'), 'utf8')

describe('NHIS medicine add single-flight protection', () => {
  it('locks synchronously before asynchronous validation and always releases the lock', () => {
    const handlerStart = nhisPage.indexOf('const addMedicineToList = async () => {')
    const nextHandler = nhisPage.indexOf('const openEditMedicine =', handlerStart)
    const handler = nhisPage.slice(handlerStart, nextHandler)

    expect(handler).toContain('if (medicineAddingRef.current) return')
    expect(handler).toContain('medicineAddingRef.current = true')
    expect(handler).toContain('setMedicineAdding(true)')
    expect(handler).toContain('finally {')
    expect(handler).toContain('medicineAddingRef.current = false')
    expect(handler).toContain('setMedicineAdding(false)')
  })

  it('disables the add action and identifies it as a non-submit button', () => {
    expect(nhisPage).toMatch(
      /<button type="button" className="btn btn-primary" disabled=\{medicineAdding\} onClick=\{addMedicineToList\}>/
    )
  })
})
