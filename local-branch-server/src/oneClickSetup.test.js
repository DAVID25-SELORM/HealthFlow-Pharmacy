import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildSetupFile, SETUP_FILE_PREFIX } from '../../src/services/offlineSetupFile.js'

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
    // The script reads a downloaded setup file but never writes the code anywhere (the only write blanks the used file).
    expect(script).not.toMatch(/Set-Content|Out-File|Add-Content/)
    expect(script.match(/WriteAllText\(([^)]*)\)/g)).toEqual(["WriteAllText($setupFileUsed, '')"])
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

  it('looks for the setup file the cloud button downloads, by the name the cloud gives it', () => {
    const script = read('scripts', 'setup-offline.ps1')
    expect(script).toContain(`${SETUP_FILE_PREFIX}*.txt`)
    expect(script).toContain('HEALTHFLOW_SETUP_EXPIRES')
    // File first, then clipboard, then paste.
    expect(script.indexOf('$setupFile = Find-SetupFile')).toBeLessThan(script.indexOf('Get-Clipboard -Raw'))
  })

  it('deletes the used setup file only after the connection succeeded, never in a dry run', () => {
    const script = read('scripts', 'setup-offline.ps1')
    const connected = script.indexOf('if (-not $connected)')
    const deletion = script.indexOf('Remove-Item -LiteralPath $setupFileUsed')
    expect(deletion).toBeGreaterThan(connected)
    expect(script.indexOf('Dry run finished')).toBeLessThan(deletion)
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

describe.runIf(process.platform === 'win32')('one-step offline setup: finding the downloaded setup file (dry run)', () => {
  const sampleResult = {
    organizationId: '3f2a9c1e-5b7d-4e8a-9c3b-1d2e4f6a8b0c',
    branchId: '8a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
    branchSyncToken: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718',
    nhiaConfigSecretKey: '0f9e8d7c6b5a49382716a5b4c3d2e1f00f9e8d7c6b5a4938',
    activationExpiresAt: new Date(Date.now() + 36 * 3600 * 1000).toISOString(),
  }
  const cloud = { cloudUrl: 'https://example-project.supabase.co', syncKey: 'sb_publishable_exampleexampleexample' }

  const runWithFolder = (dir) =>
    spawnSync(
      'powershell.exe',
      [
        '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
        path.join(serverDir, 'scripts', 'setup-offline.ps1'),
        '-DryRun', '-SetupFolders', dir, '-InstallRoot', path.join(dir, 'not-installed'),
      ],
      // Downloads is this temp folder too, so the real Downloads folder is never searched or touched.
      { encoding: 'utf8', timeout: 60000, input: '', env: { ...process.env, USERPROFILE: dir } }
    )

  const makeFolder = () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-setupfile-test-'))
    tempDirs.push(dir)
    return dir
  }

  it('uses the downloaded file, says which one, and leaves it in place during a dry run', () => {
    const dir = makeFolder()
    const file = buildSetupFile({ result: sampleResult, machineName: 'Shop', ...cloud })
    fs.writeFileSync(path.join(dir, file.fileName), file.content)
    const run = runWithFolder(dir)
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('Using the setup file HealthFlow-Setup-Shop.txt')
    expect(run.stdout).toContain('would be deleted after a successful setup')
    expect(run.stdout).not.toContain(sampleResult.branchSyncToken)
    expect(fs.existsSync(path.join(dir, file.fileName))).toBe(true)
  }, 60000)

  it('takes the newest file when there are several', () => {
    const dir = makeFolder()
    const older = buildSetupFile({ result: sampleResult, machineName: 'Old', ...cloud })
    const newer = buildSetupFile({ result: sampleResult, machineName: 'New', ...cloud })
    fs.writeFileSync(path.join(dir, older.fileName), older.content)
    fs.writeFileSync(path.join(dir, newer.fileName), newer.content)
    const hourAgo = new Date(Date.now() - 3600 * 1000)
    fs.utimesSync(path.join(dir, older.fileName), hourAgo, hourAgo)
    const run = runWithFolder(dir)
    expect(run.stdout).toContain('Using the setup file HealthFlow-Setup-New.txt')
  }, 60000)

  it('ignores a file whose code has already expired', () => {
    const dir = makeFolder()
    const expired = buildSetupFile({
      result: { ...sampleResult, activationExpiresAt: new Date(Date.now() - 3600 * 1000).toISOString() },
      machineName: 'Late',
      ...cloud,
    })
    fs.writeFileSync(path.join(dir, expired.fileName), expired.content)
    const run = runWithFolder(dir)
    expect(run.stdout).toContain('Ignoring HealthFlow-Setup-Late.txt')
    expect(run.stdout).not.toContain('Using the setup file')
    expect(fs.existsSync(path.join(dir, expired.fileName))).toBe(true)
  }, 60000)

  it('ignores a file with the right name that is not a setup file', () => {
    const dir = makeFolder()
    fs.writeFileSync(path.join(dir, 'HealthFlow-Setup-notes.txt'), 'remember to buy milk')
    const run = runWithFolder(dir)
    expect(run.stdout).toContain('is not a HealthFlow setup file; ignoring it')
    expect(run.stdout).not.toContain('Using the setup file')
  }, 60000)
})
