import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { disableInstallerInEnvFile, getDisableSummary } from './disable-offline-installer.mjs'

describe('disable offline installer helper', () => {
  it('removes installer URL variables from an env file without deleting other settings', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'healthflow-disable-installer-'))
    const envPath = path.join(dir, '.env.production')
    await fs.writeFile(
      envPath,
      [
        'VITE_SUPABASE_URL=https://project.supabase.co',
        'VITE_HEALTHFLOW_INSTALLER_URL=https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
        'HEALTHFLOW_INSTALLER_URL=https://downloads.healthflowcloud.com/HealthFlow-Offline-Installer-1.4.4.zip',
        'VITE_APP_NAME=HealthFlow',
      ].join('\n'),
      'utf8'
    )

    const result = await disableInstallerInEnvFile(envPath)
    const updated = await fs.readFile(envPath, 'utf8')

    expect(result.removed).toBe(2)
    expect(updated).toContain('VITE_SUPABASE_URL=https://project.supabase.co')
    expect(updated).toContain('VITE_APP_NAME=HealthFlow')
    expect(updated).not.toContain('HEALTHFLOW_INSTALLER_URL=')
  })

  it('reports when no installer value exists', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'healthflow-disable-installer-'))
    const envPath = path.join(dir, '.env.production')
    await fs.writeFile(envPath, 'VITE_APP_NAME=HealthFlow\n', 'utf8')

    await expect(disableInstallerInEnvFile(envPath)).resolves.toMatchObject({ removed: 0 })
  })

  it('prints production disable guidance without exposing installer secrets', () => {
    const summary = getDisableSummary()

    expect(summary).toContain('Remove VITE_HEALTHFLOW_INSTALLER_URL')
    expect(summary).toContain('The installer ZIP is not deleted')
    expect(summary).not.toContain('token')
    expect(summary).not.toContain('secret')
  })
})
