import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('offline PIN authentication', () => {
  it('stores only a facility-server-bound scrypt verifier, enforces lockout, and audits every attempt', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-offline-auth-'))
    const dbUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const snapshotUrl = pathToFileURL(
      path.resolve('local-branch-server/src/cloudSnapshotRepository.js')
    ).href
    const authUrl = pathToFileURL(
      path.resolve('local-branch-server/src/offlineAuthRepository.js')
    ).href
    const script = `
      const { db, closeDatabase, getBranchMeta } = await import(${JSON.stringify(dbUrl)});
      const { importUsersSnapshot } = await import(${JSON.stringify(snapshotUrl)});
      const auth = await import(${JSON.stringify(authUrl)});
      importUsersSnapshot([{
        id: 'staff-1', email: 'staff@example.com', full_name: 'Staff One',
        role: 'cashier', assigned_roles: ['cashier', 'inventory'],
        organization_id: 'org-1', branch_id: 'branch-1', is_active: true,
        can_refund: true
      }]);
      auth.setOfflineAccess({ targetUserId: 'staff-1', enabled: true, actorUserId: 'admin-1' });
      auth.enrollOfflinePin({ userId: 'staff-1', pin: '654321' });
      const stored = db.prepare(\`
        SELECT offline_pin_salt, offline_pin_hash FROM users WHERE id = ?
      \`).get('staff-1');
      const success = auth.authenticateOfflinePin({
        email: 'staff@example.com', pin: '654321'
      });
      const failures = [];
      for (let attempt = 0; attempt < 5; attempt += 1) {
        try {
          auth.authenticateOfflinePin({ email: 'staff@example.com', pin: '111111' });
        } catch (error) {
          failures.push({ message: error.message, status: error.status });
        }
      }
      const row = db.prepare(\`
        SELECT offline_failed_attempts, offline_locked_until FROM users WHERE id = ?
      \`).get('staff-1');
      const audit = auth.listOfflineAuthAudit(20);
      const result = {
        stored,
        serverId: getBranchMeta('offline_auth_server_id'),
        success,
        failures,
        row,
        events: audit.map((entry) => entry.event_type)
      };
      closeDatabase();
      console.log(JSON.stringify(result));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.stored.offline_pin_salt).not.toContain('654321')
      expect(result.stored.offline_pin_hash).not.toContain('654321')
      expect(result.serverId).toMatch(/^[0-9a-f-]{36}$/i)
      expect(result.success).toMatchObject({
        id: 'staff-1',
        assignedRoles: ['cashier', 'inventory'],
        permissions: { can_refund: true },
      })
      expect(result.failures).toHaveLength(5)
      expect(result.failures.at(-1)).toMatchObject({ status: 423 })
      expect(result.row.offline_failed_attempts).toBe(0)
      expect(new Date(result.row.offline_locked_until).getTime()).toBeGreaterThan(Date.now())
      expect(result.events.filter((event) => event.startsWith('offline_login.'))).toHaveLength(6)
      expect(result.events).toContain('offline_pin.enrolled')
      expect(result.events).toContain('offline_access.enabled')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
