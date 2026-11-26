// @vitest-environment node
// Someone from another pharmacy signs in to HealthFlow Cloud and tries this computer. They are refused, and nothing
// about them may be left behind here. The cloud is a stand-in; the sign-in code and the database are real.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

const cloud = vi.hoisted(() => ({ profile: null }))
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    auth: { getUser: async () => ({ data: { user: { id: cloud.profile.id, email: cloud.profile.email } }, error: null }) },
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: cloud.profile, error: null }) }) }),
    }),
  }),
}))

const HERE = '11111111-1111-4111-8111-111111111111'
const ELSEWHERE = '33333333-3333-4333-8333-333333333333'
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-outsider-'))
let db
let closeDatabase
let issueBranchUserSession
let previousPath

const profile = (id, organization, extra = {}) => ({
  id, email: `${id}@example.test`, full_name: `Invented ${id}`, role: 'admin', assigned_roles: ['admin'],
  organization_id: organization, branch_id: null, is_active: true, ...extra,
})
const saved = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id)

beforeAll(async () => {
  previousPath = process.env.HEALTHFLOW_DB_PATH
  process.env.HEALTHFLOW_DB_PATH = path.join(directory, 'branch.sqlite')
  vi.resetModules()
  const { config } = await import('./config.js')
  Object.assign(config, {
    organizationId: HERE, branchId: null, supabaseUrl: 'https://invented.supabase.co',
    supabaseSyncKey: 'invented-publishable-key', branchServerToken: 'invented-server-key-for-this-test',
  })
  ;({ db, closeDatabase } = await import('./db.js'))
  ;({ issueBranchUserSession } = await import('./httpAuth.js'))
})

afterAll(() => {
  closeDatabase?.()
  if (previousPath === undefined) delete process.env.HEALTHFLOW_DB_PATH
  else process.env.HEALTHFLOW_DB_PATH = previousPath
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 })
})

describe('a staff member of another pharmacy trying this computer', () => {
  it('is refused and nothing about them is saved', async () => {
    cloud.profile = profile('outsider', ELSEWHERE)
    await expect(issueBranchUserSession({ accessToken: 'invented-token' })).rejects.toThrow(/does not belong to this facility/)
    expect(saved('outsider')).toBeUndefined()
  })

  it("does not change what this pharmacy's own staff get", async () => {
    cloud.profile = profile('own-staff', HERE)
    await expect(issueBranchUserSession({ accessToken: 'invented-token' })).resolves.toMatchObject({ userId: 'own-staff' })
    expect(saved('own-staff')).toMatchObject({ organization_id: HERE, is_active: 1 })
  })

  it('still records that one of this pharmacy\'s own staff was disabled, so their offline access ends', async () => {
    cloud.profile = profile('own-staff', HERE, { is_active: false })
    await expect(issueBranchUserSession({ accessToken: 'invented-token' })).rejects.toThrow(/disabled/)
    expect(saved('own-staff').is_active).toBe(0)
  })
})
