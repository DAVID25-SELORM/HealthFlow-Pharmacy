import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const readScript = (name) =>
  fs.readFileSync(path.join(serverDir, 'scripts', name), 'utf8')

describe('Linux signed updater scripts', () => {
  it('installs a root-owned helper and narrow sudo policy', () => {
    const installer = readScript('install-linux-service.sh')

    expect(installer).toContain('/usr/local/lib/healthflow')
    expect(installer).toContain('/etc/healthflow-branch-updater.conf')
    expect(installer).toContain('/etc/sudoers.d/healthflow-branch-updater')
    expect(installer).toContain('NOPASSWD: ${UPDATER_PATH} *')
    expect(installer).toContain('install -o root -g root -m 0755')
    expect(installer).toContain('visudo -cf')
    expect(installer).toContain('systemctl stop "${SERVICE_NAME}"')
    expect(installer).toContain('systemctl start "${SERVICE_NAME}"')
  })

  it('restricts packages, preserves facility state, verifies health, and rolls back', () => {
    const updater = readScript('apply-update-linux.sh')

    expect(updater).toContain('EXPECTED_PACKAGE_PATH="${UPDATES_DIR}/pending-update.zip"')
    expect(updater).toContain("! -name '.env'")
    expect(updater).toContain("! -name 'updates'")
    expect(updater).toContain("! -name 'data'")
    expect(updater).toContain('npm ci --omit=dev')
    expect(updater).toContain('npm run rebuild:sqlite')
    expect(updater).toContain('"http://127.0.0.1:${port}/health"')
    expect(updater).toContain('restore_backup')
    expect(updater).toContain('write_status "rolled_back"')
  })
})
