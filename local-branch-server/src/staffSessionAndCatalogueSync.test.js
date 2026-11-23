import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

// These tests run the real modules in a child process against a temporary SQLite file, with the network
// replaced by a recording fake. They cover two failures found on the first real computer:
//  1. Staff sign-in on the branch server failed ("Cannot read properties of null (reading 'id')") because the
//     staff profile was read without the staff member's own access token, so the cloud returned no row.
//  2. The reference-data download failed ("column nhia_tariff_items.organization_id does not exist") because
//     shared catalogues were filtered by organisation.

const serverDirectory = path.resolve('local-branch-server')
const moduleUrl = (name) => pathToFileURL(path.resolve('local-branch-server/src', name)).href

const runChild = (script, extraEnv = {}) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-session-'))
  try {
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: serverDirectory,
      env: {
        ...process.env,
        HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite'),
        BRANCH_SERVER_TOKEN: 'test-branch-server-token-with-enough-entropy-1234567890',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SYNC_KEY: 'sb_publishable_test_key',
        BRANCH_SYNC_TOKEN: 'test-branch-sync-token',
        ORGANIZATION_ID: '',
        BRANCH_ID: '',
        ...extraEnv,
      },
      encoding: 'utf8',
    })
    return JSON.parse(output.trim().split(/\r?\n/).at(-1))
  } finally {
    fs.rmSync(directory, { recursive: true, force: true })
  }
}

const json = `(body, status = 200, headers = {}) =>
  new Response(body === null ? '' : JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  })`

describe('staff sign-in on the branch server', () => {
  it('reads the staff profile with the staff member\'s own access token', () => {
    const script = `
      const json = ${json};
      const calls = [];
      const row = {
        id: 'user-1', email: 'owner@example.com', full_name: 'Owner', role: 'admin',
        assigned_roles: ['admin'], organization_id: 'org-1', branch_id: 'branch-1', is_active: true,
        can_manage_claims: true,
      };
      globalThis.fetch = async (url, options = {}) => {
        const target = String(url);
        const authorization = new Headers(options.headers || {}).get('authorization');
        calls.push({ target, authorization });
        if (target.includes('/auth/v1/user')) {
          return json({ id: 'user-1', aud: 'authenticated', email: 'owner@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
        }
        if (target.includes('/rest/v1/users')) {
          // Row-level security: only the signed-in staff member's own token can see the row; for anyone else
          // the cloud simply returns no rows (an empty list, not an error).
          if (authorization === 'Bearer staff-access-token') return json([row]);
          return json([]);
        }
        throw new Error('Unexpected request ' + target);
      };
      const { issueBranchUserSession } = await import(${JSON.stringify(moduleUrl('httpAuth.js'))});
      const { closeDatabase } = await import(${JSON.stringify(moduleUrl('db.js'))});
      const session = await issueBranchUserSession({ accessToken: 'staff-access-token', activeRole: 'admin' });
      closeDatabase();
      const profileCall = calls.find((call) => call.target.includes('/rest/v1/users'));
      console.log(JSON.stringify({ role: session.role, userId: session.userId, hasToken: Boolean(session.token), profileAuthorization: profileCall.authorization }));
    `
    const result = runChild(script)

    expect(result).toEqual({
      role: 'admin',
      userId: 'user-1',
      hasToken: true,
      profileAuthorization: 'Bearer staff-access-token',
    })
  })

  it('says clearly when no staff profile exists, instead of a null error', () => {
    const script = `
      const json = ${json};
      globalThis.fetch = async (url) => {
        const target = String(url);
        if (target.includes('/auth/v1/user')) {
          return json({ id: 'user-2', aud: 'authenticated', email: 'nobody@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' });
        }
        return json([]);
      };
      const { issueBranchUserSession } = await import(${JSON.stringify(moduleUrl('httpAuth.js'))});
      const { closeDatabase } = await import(${JSON.stringify(moduleUrl('db.js'))});
      let outcome = {};
      try {
        await issueBranchUserSession({ accessToken: 'some-token', activeRole: 'admin' });
      } catch (error) {
        outcome = { name: error.name, status: error.status, message: error.message };
      }
      closeDatabase();
      console.log(JSON.stringify(outcome));
    `
    const result = runChild(script)

    expect(result.name).toBe('Error')
    expect(result.status).toBe(403)
    expect(result.message).toContain('No staff profile was found')
  })
})

describe('reference data download', () => {
  it('does not filter the shared tariff and clinical-rule catalogues by organisation', () => {
    const script = `
      const json = ${json};
      const urls = [];
      globalThis.fetch = async (url) => {
        const target = String(url);
        urls.push(target);
        return json([], 200, { 'Content-Range': '*/0' });
      };
      const { pullReferenceData } = await import(${JSON.stringify(moduleUrl('supabaseSync.js'))});
      const { closeDatabase } = await import(${JSON.stringify(moduleUrl('db.js'))});
      let failure = '';
      try { await pullReferenceData(); } catch (error) { failure = String(error && error.message || error); }
      closeDatabase();
      const rest = urls.filter((target) => target.includes('/rest/v1/'));
      const filtered = (table) => rest.filter((target) => target.includes('/rest/v1/' + table + '?')).map((target) => target.includes('organization_id=eq.'));
      console.log(JSON.stringify({
        failure,
        tariff: filtered('nhia_tariff_items'),
        rules: filtered('nhis_clinical_rules'),
        patients: filtered('patients'),
        drugs: filtered('nhis_drugs'),
      }));
    `
    const result = runChild(script, { ORGANIZATION_ID: 'org-1' })

    expect(result.failure).toBe('')
    // The shared catalogues are requested without an organisation filter...
    expect(result.tariff.length).toBeGreaterThan(0)
    expect(result.tariff.every((hasFilter) => hasFilter === false)).toBe(true)
    expect(result.rules.length).toBeGreaterThan(0)
    expect(result.rules.every((hasFilter) => hasFilter === false)).toBe(true)
    // ...while organisation data still is.
    expect(result.patients.length).toBeGreaterThan(0)
    expect(result.patients.every((hasFilter) => hasFilter === true)).toBe(true)
    expect(result.drugs.every((hasFilter) => hasFilter === true)).toBe(true)
  })
})
