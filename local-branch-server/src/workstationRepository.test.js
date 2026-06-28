import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('authorized workstation enrollment', () => {
  it('uses one-time enrollment tokens and immediately enforces revocation', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-workstation-'))
    const repositoryUrl = pathToFileURL(
      path.resolve('local-branch-server/src/workstationRepository.js')
    ).href
    const script = `
      const repo = await import(${JSON.stringify(repositoryUrl)});
      const enrollment = repo.enrollWorkstation({
        enrollmentToken: 'one-time-enrollment-token',
        computerName: 'RECEPTION-01',
        ipAddress: '192.168.1.25'
      });
      let reusedStatus = null;
      try {
        repo.enrollWorkstation({
          enrollmentToken: 'one-time-enrollment-token',
          computerName: 'RECEPTION-02'
        });
      } catch (error) {
        reusedStatus = error.status;
      }
      const check = () => {
        const result = { next: false, status: null };
        const request = {
          ip: '192.168.1.25',
          get: (name) => ({
            'x-healthflow-workstation-id': enrollment.id,
            'x-healthflow-workstation-secret': enrollment.secret
          })[name] || ''
        };
        const response = {
          status: (value) => { result.status = value; return response; },
          json: () => response
        };
        repo.requireAuthorizedWorkstation(request, response, () => { result.next = true; });
        return result;
      };
      const before = check();
      repo.revokeAuthorizedWorkstation({ id: enrollment.id, actorUserId: 'admin-1' });
      const after = check();
      console.log(JSON.stringify({
        before,
        after,
        reusedStatus,
        workstations: repo.listAuthorizedWorkstations()
      }));
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite'),
          HEALTHFLOW_WORKSTATION_ENROLLMENT_TOKEN: 'one-time-enrollment-token',
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))
      expect(result.before).toEqual({ next: true, status: null })
      expect(result.after).toEqual({ next: false, status: 401 })
      expect(result.reusedStatus).toBe(401)
      expect(result.workstations[0]).toMatchObject({
        computer_name: 'RECEPTION-01',
        status: 'revoked',
        revoked_by: 'admin-1',
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
