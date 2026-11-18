import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'

const serverDir = path.resolve('local-branch-server')
const read = (...parts) => fs.readFileSync(path.join(serverDir, ...parts), 'utf8')

// Made-up values in the shape the cloud screen produces. None of these is a real credential.
const GOOD_BLOCK = [
  'PORT=4780',
  'NHIA_CONFIG_SECRET_KEY=0f9e8d7c6b5a49382716a5b4c3d2e1f00f9e8d7c6b5a4938',
  'ORGANIZATION_ID=3f2a9c1e-5b7d-4e8a-9c3b-1d2e4f6a8b0c',
  'BRANCH_ID=8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
  'BRANCH_SYNC_TOKEN=a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
  'SUPABASE_URL=https://example-project.supabase.co',
  'SUPABASE_SYNC_KEY=sb_publishable_exampleexampleexample',
  'HEALTHFLOW_UPDATE_MANIFEST_URL=<your-signed-update-manifest-url>',
].join('\n')

const tempDirs = []
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop(), { recursive: true, force: true })
})

const runCheck = (input) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-oneclick-test-'))
  tempDirs.push(dir)
  const sentinel = path.join(dir, 'real.env')
  fs.writeFileSync(sentinel, 'SENTINEL=untouched\n')
  const result = spawnSync(
    process.execPath,
    [path.join(serverDir, 'scripts', 'connect-to-cloud.mjs'), '--check'],
    { input, encoding: 'utf8', env: { ...process.env, HEALTHFLOW_ENV_PATH: sentinel }, timeout: 30000 }
  )
  return { result, sentinel, dir }
}

describe('one-step offline setup: the --check mode that runs before anything is installed', () => {
  it('accepts a complete setup code without writing the real settings file', () => {
    const { result, sentinel } = runCheck(GOOD_BLOCK)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('complete and valid')
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('SENTINEL=untouched\n')
    expect(fs.existsSync(`${sentinel}.before-cloud-connect`)).toBe(false)
  })

  it('refuses a code the real save would refuse, and changes nothing', () => {
    const { result, sentinel } = runCheck(GOOD_BLOCK.replace(/BRANCH_SYNC_TOKEN=.*/, 'BRANCH_SYNC_TOKEN=short'))
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('NOT SAVED')
    expect(fs.readFileSync(sentinel, 'utf8')).toBe('SENTINEL=untouched\n')
  })

  it('refuses an empty or incomplete clipboard', () => {
    expect(runCheck('').result.status).toBe(2)
    expect(runCheck('ORGANIZATION_ID=3f2a9c1e-5b7d-4e8a-9c3b-1d2e4f6a8b0c').result.status).toBe(2)
  })

  it('never prints a token or key', () => {
    const { result } = runCheck(GOOD_BLOCK)
    const shown = `${result.stdout}${result.stderr}`
    for (const secret of ['a1b2c3d4e5f60718293a4b5c6d7e8f90', 'sb_publishable_example', '0f9e8d7c6b5a4938']) {
      expect(shown).not.toContain(secret)
    }
  })
})

describe('one-step offline setup: wiring', () => {
  it('the launcher asks for administrator rights once and holds the window open', () => {
    const launcher = read('Set-Up-HealthFlow-Offline.cmd')
    expect(launcher).toMatch(/-Verb RunAs/)
    expect(launcher).toMatch(/'-Sta'/)
    expect(launcher).toContain('-WaitAtEnd')
    // Works from the ZIP root and from inside the server folder.
    expect(launcher).toContain('scripts\\setup-offline.ps1')
    expect(launcher).toContain('local-branch-server\\scripts\\setup-offline.ps1')
  })

  it('checks the setup code before installing, then installs, connects and opens the POS in that order', () => {
    const script = read('scripts', 'setup-offline.ps1')
    const at = (needle) => {
      const index = script.indexOf(needle)
      expect(index, `missing: ${needle}`).toBeGreaterThan(-1)
      return index
    }
    const check = at('--check')
    const install = at('& $installScript')
    const connect = at('& $connectScript')
    const open = at('Start-Process $serverUrl')
    expect(check).toBeLessThan(install)
    expect(install).toBeLessThan(connect)
    expect(connect).toBeLessThan(open)
  })

  it('installs offline-only, without the installer opening a browser before the cloud is connected', () => {
    const script = read('scripts', 'setup-offline.ps1')
    expect(script).toMatch(/-OfflineOnly\s+-NoBrowser/)
    expect(read('scripts', 'install-windows-service.ps1')).toMatch(/\[switch\]\$NoBrowser/)
  })

  it('hands the code to the connect helper in memory, never through a file or a command line', () => {
    const script = read('scripts', 'setup-offline.ps1')
    expect(script).toMatch(/-Block \$block/)
    expect(script).not.toMatch(/Set-Content|Out-File|\.txt/)
    expect(script).not.toMatch(/Write-Host[^\n]*\$block/)
    expect(read('scripts', 'connect-to-cloud.ps1')).toMatch(/\[string\]\$Block = ''/)
  })

  it('clears the setup code from the clipboard after it succeeds', () => {
    expect(read('scripts', 'setup-offline.ps1')).toMatch(/Set-Clipboard -Value \$null/)
  })

  it('the existing connect launcher now keeps its window open so the result can be read', () => {
    expect(read('Connect-To-HealthFlow-Cloud.cmd')).toContain('-WaitAtEnd')
    expect(read('scripts', 'connect-to-cloud.ps1')).toMatch(/\[switch\]\$WaitAtEnd/)
  })

  it('the installer builder puts the launcher at the top of the ZIP and describes the one-button steps', () => {
    const builder = read('scripts', 'build-offline-installer-package.ps1')
    expect(builder).toContain("Join-Path $stagingRoot 'Set-Up-HealthFlow-Offline.cmd'")
    expect(builder).toMatch(/Double-click Set-Up-HealthFlow-Offline\.cmd/)
  })
})

// Runs the real script in its dry-run mode: validates the code and prints the plan, installs nothing.
describe.runIf(process.platform === 'win32')('one-step offline setup: dry run on Windows', () => {
  const runDryRun = (block) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-oneclick-dry-'))
    tempDirs.push(dir)
    const blockFile = path.join(dir, 'block.txt')
    fs.writeFileSync(blockFile, block)
    return spawnSync(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(serverDir, 'scripts', 'setup-offline.ps1'),
        '-DryRun', '-BlockFile', blockFile, '-InstallRoot', path.join(dir, 'not-installed'),
      ],
      { encoding: 'utf8', timeout: 60000 }
    )
  }

  it('shows the plan for a good code and changes nothing', () => {
    const result = runDryRun(GOOD_BLOCK)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('Dry run finished. Nothing was changed.')
    expect(result.stdout).not.toContain('a1b2c3d4e5f60718293a4b5c6d7e8f90')
  }, 60000)

  it('stops before installing when the code is bad', () => {
    const result = runDryRun(GOOD_BLOCK.replace(/BRANCH_SYNC_TOKEN=.*/, 'BRANCH_SYNC_TOKEN=short'))
    expect(result.status).toBe(1)
    expect(result.stdout).toContain('nothing was installed')
  }, 60000)
})
