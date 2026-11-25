import { readFileSync } from 'node:fs'
import { test, expect } from '@playwright/test'
import { installFakeBackend } from './support/fakeBackend.js'

// The unpacked size of each part, read from the list at the end of a zip file (.xlsx is a zip).
const partSizes = (file) => {
  const end = file.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]))
  const sizes = []
  let at = file.readUInt32LE(end + 16)
  for (let index = 0; index < file.readUInt16LE(end + 10); index += 1) {
    sizes.push(file.readUInt32LE(at + 24))
    at += 46 + file.readUInt16LE(at + 28) + file.readUInt16LE(at + 30) + file.readUInt16LE(at + 32)
  }
  return sizes
}

// A large Excel download is compressed in a background worker. The live site's security rule
// once blocked that worker, so the download never finished. The preview server used by these
// tests sends no security rule, so this one adds the live rule from vercel.json.
const LIVE_POLICY = JSON.parse(readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'))
  .headers.flatMap((entry) => entry.headers)
  .find((header) => header.key === 'Content-Security-Policy').value

// The Excel library only uses the worker for a part of the file this big or bigger.
const WORKER_THRESHOLD_BYTES = 160_000

const today = new Date().toISOString().slice(0, 10)

// Invented patients, enough to make a large file.
const CLAIM_LINES = Array.from({ length: 700 }, (_, index) => {
  const number = String(index + 1).padStart(4, '0')
  return {
    id: `line-${number}`,
    claim_id: `claim-${number}`,
    drug_code: 'TESTMED1',
    description: 'Testmedicine Tablet 20mg',
    unit: 'tablet',
    unit_price: 2,
    dispensed_qty: 30,
    served_qty: 30,
    serving_status: 'fully_served',
    total_amount: 60,
    dispensary_date: today,
    nhis_claims: {
      id: `claim-${number}`,
      organization_id: 'org-guard-1',
      claim_number: `TEST-${number}`,
      surname: `PATIENT${number}`,
      other_names: 'INVENTED',
      member_no: `9000${number}`,
      folder_no: `F${number}`,
      ccc_no: `1${number}`,
      gender: 'Female',
      date_of_birth: '1980-01-01',
      service_date_from: today,
      status: 'served',
    },
  }
})

test('a large Excel download finishes under the live security rule', async ({ page, baseURL }, testInfo) => {
  test.skip(testInfo.project.name !== 'computer', 'One screen size is enough for a file download.')

  const blocked = []
  page.on('console', (message) => {
    if (message.text().includes('Content Security Policy')) blocked.push(message.text())
  })

  await page.route(`${baseURL}/**`, async (route) => {
    const response = await route.fetch()
    await route.fulfill({ response, headers: { ...response.headers(), 'content-security-policy': LIVE_POLICY } })
  })
  await installFakeBackend(page, 'admin', { tables: { nhis_claim_medicines: CLAIM_LINES } })

  await page.goto('/nhis')
  await page.getByRole('button', { name: 'Medicine search' }).click()
  const dialog = page.getByRole('dialog', { name: 'Medicine search' })
  await dialog.getByLabel('Medicines to look for').fill('Testmedicine')
  await dialog.getByLabel('Look in').selectOption('nhis')
  await dialog.getByRole('button', { name: 'Search', exact: true }).click()
  await expect(dialog.getByText(`1-50 of ${CLAIM_LINES.length}`)).toBeVisible()

  const downloading = page.waitForEvent('download', { timeout: 30_000 })
  await dialog.getByRole('button', { name: 'Download Excel' }).click()
  const download = await downloading

  expect(download.suggestedFilename()).toMatch(/\.xlsx$/)
  const largestPart = Math.max(...partSizes(readFileSync(await download.path())))
  // If this fails the file is too small to use the worker, and the test proves nothing.
  expect(largestPart).toBeGreaterThan(WORKER_THRESHOLD_BYTES)
  expect(blocked, 'nothing was blocked by the security rule').toEqual([])
})
