import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('hospital NHIA claim persistence', () => {
  it('builds fallback CLAIM-it token request variants', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-claimit-token-variants-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { buildClaimItTokenRequestCandidates } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const candidates = buildClaimItTokenRequestCandidates({
        baseUrl: 'http://localhost:31719/json-api',
        tokenPath: '/token',
        username: 'claimit-user',
        password: 'secret-pass',
      }).map((candidate) => ({
        label: candidate.label,
        method: candidate.init.method,
        url: candidate.url.toString(),
        contentType: candidate.init.headers['Content-Type'] || '',
        hasBody: Boolean(candidate.init.body),
      }));
      closeDatabase();
      console.log(JSON.stringify(candidates));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const candidates = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(candidates).toEqual([
        expect.objectContaining({
          label: 'query POST',
          method: 'POST',
          url: expect.stringContaining('/token?username=claimit-user&password=secret-pass'),
          hasBody: false,
        }),
        expect.objectContaining({
          label: 'form POST',
          method: 'POST',
          url: 'http://localhost:31719/json-api/token',
          contentType: 'application/x-www-form-urlencoded;charset=UTF-8',
          hasBody: true,
        }),
        expect.objectContaining({
          label: 'json POST',
          method: 'POST',
          url: 'http://localhost:31719/json-api/token',
          contentType: 'application/json',
          hasBody: true,
        }),
        expect.objectContaining({
          label: 'query GET',
          method: 'GET',
          url: expect.stringContaining('/token?username=claimit-user&password=secret-pass'),
          hasBody: false,
        }),
      ])
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('preserves CLAIM-it upstream error details for local submit failures', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-claimit-error-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { getClaimItUpstreamErrorMessage } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const message = getClaimItUpstreamErrorMessage({ user_msg: 'Invalid CLAIM-it username or password.' });
      closeDatabase();
      console.log(JSON.stringify({ message }));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.message).toBe('Invalid CLAIM-it username or password.')
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('requires CLAIM-it saved or passed counts before accepting a submission', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-claimit-acceptance-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { getClaimItSubmissionAcceptanceError } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const ambiguous = getClaimItSubmissionAcceptanceError({ success: true });
      const saved = getClaimItSubmissionAcceptanceError({ success: true, savedClaims: 1 });
      const passed = getClaimItSubmissionAcceptanceError({ passedClaims: 1, failedClaims: 0 });
      closeDatabase();
      console.log(JSON.stringify({ ambiguous, saved, passed }));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.ambiguous).toBe('CLAIM-it returned success but did not report any saved or passed claims.')
      expect(result.saved).toBe('')
      expect(result.passed).toBe('')
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('surfaces nested CLAIM-it rejection details', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-claimit-detail-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { getClaimItSubmissionAcceptanceError } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const message = getClaimItSubmissionAcceptanceError({
        failedClaims: 1,
        savedClaims: 0,
        claims: [{
          claimNumber: 'NHIS-OFF-260614-E026',
          validationErrors: [
            { field: 'medicineentries[0].drugCode', message: 'Drug is not allowed for this facility level.' },
          ],
        }],
      });
      closeDatabase();
      console.log(JSON.stringify({ message }));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.message).toContain('Drug is not allowed for this facility level.')
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('uses raw CLAIM-it tokens in the Authorization header', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-claimit-auth-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { buildClaimItAuthorizationHeader } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const header = buildClaimItAuthorizationHeader('claimit-token-123');
      closeDatabase();
      console.log(JSON.stringify({ header }));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.header).toBe('claimit-token-123')
      expect(result.header).not.toMatch(/^Bearer\s+/i)
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('persists, reloads, and totals a service-only hospital claim', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-nhia-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { createNhiaClaim, getNhiaClaim } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const saved = createNhiaClaim({
        patientName: 'Test Patient',
        memberNumber: '12345678',
        organizationType: 'hospital',
        diagnosis: 'Test diagnosis',
        serviceDate: '2026-06-13',
        items: [],
        services: [{
          gdrgCode: 'GDRG-001',
          description: 'Hospital service',
          quantity: 2,
          unitPrice: 15,
          totalAmount: 1,
        }],
      });
      const reloaded = getNhiaClaim(saved.id);
      closeDatabase();
      console.log(JSON.stringify(reloaded));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const reloaded = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(reloaded.totalAmount).toBe(30)
      expect(reloaded.items).toEqual([])
      expect(reloaded.services).toEqual([
        expect.objectContaining({
          gdrgCode: 'GDRG-001',
          quantity: 2,
          unitPrice: 15,
          totalAmount: 30,
        }),
      ])
      expect(reloaded.payload.services).toEqual([
        expect.objectContaining({
          code: 'GDRG-001',
          totalAmount: 30,
        }),
      ])
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('rejects medicine prices that conflict with the local NHIS catalogue', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-nhia-price-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { createNhiaClaim } = await import(${JSON.stringify(repositoryUrl)});
      const { db, closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      db.prepare(
        'INSERT INTO drugs (id, name, price, nhis_code, nhis_price) VALUES (?, ?, ?, ?, ?)'
      ).run('drug-1', 'Catalogue medicine', 10, 'NHIS-001', 10);
      try {
        createNhiaClaim({
          patientName: 'Test Patient',
          memberNumber: '12345678',
          serviceDate: '2026-06-13',
          items: [{
            drugId: 'drug-1',
            name: 'Catalogue medicine',
            nhiaCode: 'NHIS-001',
            quantity: 2,
            unitPrice: 99,
            totalPrice: 1,
          }],
        });
        console.log(JSON.stringify({ rejected: false }));
      } catch (error) {
        console.log(JSON.stringify({ rejected: true, message: error.message }));
      } finally {
        closeDatabase();
      }
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result).toEqual({
        rejected: true,
        message: 'NHIA claim item price does not match the local catalogue for NHIS-001.',
      })
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('resolves offline NHIS claim records for direct CLAIM-it submission validation', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-nhis-direct-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const offlineRepositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/offlineRecordsRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { resolveDirectSubmissionLocalClaims } = await import(${JSON.stringify(repositoryUrl)});
      const { saveOfflineRecord } = await import(${JSON.stringify(offlineRepositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      saveOfflineRecord('nhis_claims', {
        id: '3f3e0422-594f-4ef4-a528-3979722107ee',
        claim_number: 'NHIS-000014',
        status: 'served',
      });
      const claims = resolveDirectSubmissionLocalClaims(['3f3e0422-594f-4ef4-a528-3979722107ee']);
      closeDatabase();
      console.log(JSON.stringify(claims));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const claims = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(claims).toEqual([
        {
          id: '3f3e0422-594f-4ef4-a528-3979722107ee',
          claimNumber: 'NHIS-000014',
          source: 'offline_nhis_claims',
        },
      ])
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })

  it('adds CLAIM-it claim IDs before forwarding direct relational payloads', () => {
    const testDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-claimit-claim-id-'))
    const repositoryUrl = pathToFileURL(path.resolve('local-branch-server/src/nhiaRepository.js')).href
    const databaseUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const script = `
      const { withDirectSubmissionClaimIds } = await import(${JSON.stringify(repositoryUrl)});
      const { closeDatabase } = await import(${JSON.stringify(databaseUrl)});
      const payload = withDirectSubmissionClaimIds({
        payloadFormat: 'claimit_relational_json_v1',
        claimReferences: [{ claimNumber: 'NHIS-OFF-260614-E026' }],
        data: {
          claims: [{
            guid: '8fdce6ff-1ec4-5967-b7ba-7d93a9f4a781',
            claimNumber: 'NHIS-OFF-260614-E026',
          }],
        },
      }, [{
        id: 'e026c30b-3b22-4340-b763-62a625bbffe9',
        claimNumber: 'NHIS-OFF-260614-E026',
        source: 'offline_nhis_claims',
      }]);
      closeDatabase();
      console.log(JSON.stringify(payload));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(testDirectory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const payload = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(payload.claimReferences[0]).toMatchObject({
        claimID: '8fdce6ff-1ec4-5967-b7ba-7d93a9f4a781',
        claimId: 'e026c30b-3b22-4340-b763-62a625bbffe9',
        localClaimId: 'e026c30b-3b22-4340-b763-62a625bbffe9',
        claimNumber: 'NHIS-OFF-260614-E026',
      })
      expect(payload.data.claims[0]).toMatchObject({
        claimID: '8fdce6ff-1ec4-5967-b7ba-7d93a9f4a781',
        claimId: 'e026c30b-3b22-4340-b763-62a625bbffe9',
        localClaimId: 'e026c30b-3b22-4340-b763-62a625bbffe9',
      })
    } finally {
      fs.rmSync(testDirectory, { recursive: true, force: true })
    }
  })
})
