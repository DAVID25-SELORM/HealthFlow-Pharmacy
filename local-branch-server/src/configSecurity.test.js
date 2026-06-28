import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('branch server transport security', () => {
  it('reports local-only mode when the expected certificate files are missing', () => {
    const tlsUrl = pathToFileURL(path.resolve('local-branch-server/src/tlsSettings.js')).href
    const script = `
      const { getPublicTlsStatus, inspectTlsRuntime } = await import(${JSON.stringify(tlsUrl)});
      console.log(JSON.stringify(getPublicTlsStatus(inspectTlsRuntime())));
    `
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: path.resolve('local-branch-server'),
      env: {
        ...process.env,
        BRANCH_SERVER_TOKEN: 'test-branch-token-with-at-least-32-characters',
        HEALTHFLOW_TLS_CERT_PATH: path.join(path.resolve('local-branch-server'), 'missing-server.crt'),
        HEALTHFLOW_TLS_KEY_PATH: path.join(path.resolve('local-branch-server'), 'missing-server.key'),
        CLAIM_BRIDGE_ENABLED: 'false',
      },
      encoding: 'utf8',
    })
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

    expect(result).toMatchObject({
      ready: false,
      status: 'Not Configured',
      mode: 'local-only',
      certExists: false,
      keyExists: false,
    })
    expect(result.warning).toContain('trusted TLS certificate')
  })

  it('persists only validated TLS paths and LAN addressing metadata', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-tls-settings-'))
    const envPath = path.join(directory, '.env')
    const tlsUrl = pathToFileURL(path.resolve('local-branch-server/src/tlsSettings.js')).href
    const script = `
      const fs = await import('node:fs');
      const { saveTlsSettings } = await import(${JSON.stringify(tlsUrl)});
      const result = saveTlsSettings({
        lanHostname: 'server-pc',
        lanIp: '192.168.1.20',
        certPath: 'C:\\\\HealthFlowLocal\\\\certs\\\\server.crt',
        keyPath: 'C:\\\\HealthFlowLocal\\\\certs\\\\server.key'
      });
      console.log(JSON.stringify({ result, content: fs.readFileSync(process.env.HEALTHFLOW_ENV_PATH, 'utf8') }));
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_ENV_PATH: envPath,
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))
      expect(result.result).toMatchObject({ host: '0.0.0.0', restartRequired: true })
      expect(result.content).toContain('HEALTHFLOW_LAN_HOSTNAME=server-pc')
      expect(result.content).toContain('HEALTHFLOW_LAN_IP=192.168.1.20')
      expect(result.content).toContain('HEALTHFLOW_TLS_CERT_PATH=C:\\HealthFlowLocal\\certs\\server.crt')
      expect(result.content).toContain('HEALTHFLOW_TLS_KEY_PATH=C:\\HealthFlowLocal\\certs\\server.key')
      expect(result.content).not.toContain('BEGIN CERTIFICATE')
      expect(result.content).not.toContain('PRIVATE KEY')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })

  it('validates and persists facility sync configuration without replacing the local server token', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-cloud-settings-'))
    const envPath = path.join(directory, '.env')
    fs.writeFileSync(envPath, 'BRANCH_SERVER_TOKEN=keep-local-token\n', 'utf8')
    const tlsUrl = pathToFileURL(path.resolve('local-branch-server/src/tlsSettings.js')).href
    const script = `
      const fs = await import('node:fs');
      const { saveCloudSyncSettings } = await import(${JSON.stringify(tlsUrl)});
      const result = saveCloudSyncSettings({
        organizationId: '11111111-1111-4111-8111-111111111111',
        branchId: '22222222-2222-4222-8222-222222222222',
        branchSyncToken: 'branch-sync-token-with-at-least-32-characters',
        supabaseUrl: 'https://project.supabase.co',
        supabaseSyncKey: 'publishable-key-with-sufficient-length',
        nhiaConfigSecretKey: 'generated-nhia-key'
      });
      console.log(JSON.stringify({ result, content: fs.readFileSync(process.env.HEALTHFLOW_ENV_PATH, 'utf8') }));
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: { ...process.env, HEALTHFLOW_ENV_PATH: envPath },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))
      expect(result.result.restartRequired).toBe(true)
      expect(result.content).toContain('BRANCH_SERVER_TOKEN=keep-local-token')
      expect(result.content).toContain('ORGANIZATION_ID=11111111-1111-4111-8111-111111111111')
      expect(result.content).toContain('SUPABASE_URL=https://project.supabase.co')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
