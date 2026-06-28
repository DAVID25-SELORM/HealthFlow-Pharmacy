import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('branch server transport security', () => {
  it('refuses a non-loopback listener without TLS', () => {
    const configUrl = pathToFileURL(path.resolve('local-branch-server/src/config.js')).href
    const script = `
      const { assertConfiguredForServer } = await import(${JSON.stringify(configUrl)});
      try {
        assertConfiguredForServer();
        console.log(JSON.stringify({ accepted: true }));
      } catch (error) {
        console.log(JSON.stringify({ accepted: false, message: error.message }));
      }
    `
    const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
      cwd: path.resolve('local-branch-server'),
      env: {
        ...process.env,
        HOST: '0.0.0.0',
        BRANCH_SERVER_TOKEN: 'test-branch-token-with-at-least-32-characters',
        HEALTHFLOW_TLS_CERT_PATH: '',
        HEALTHFLOW_TLS_KEY_PATH: '',
        CLAIM_BRIDGE_ENABLED: 'false',
      },
      encoding: 'utf8',
    })
    const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

    expect(result.accepted).toBe(false)
    expect(result.message).toContain('HTTPS is required')
  })
})
