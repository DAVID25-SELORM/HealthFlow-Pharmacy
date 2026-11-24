import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { getManifestSigningPayload } from './updateManager.js'
import {
  compareVersions,
  listZipEntries,
  signingPayload,
  verifyUpdateRelease,
} from '../scripts/verify-update-release.mjs'

// A small ZIP writer so the tests need no archive library: entries are { name, content }.
const buildZip = (entries) => {
  const locals = []
  const centrals = []
  let offset = 0
  for (const { name, content } of entries) {
    const nameBuffer = Buffer.from(name, 'utf8')
    const raw = Buffer.from(content)
    const data = zlib.deflateRawSync(raw)
    const crc = zlib.crc32 ? zlib.crc32(raw) : 0
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(8, 8)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(data.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBuffer.length, 26)
    locals.push(local, nameBuffer, data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(8, 10)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(data.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBuffer.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, nameBuffer)
    offset += local.length + nameBuffer.length + data.length
  }
  const centralBuffer = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, centralBuffer, end])
}

const goodEntries = (version = '1.5.17') => [
  { name: 'local-branch-server/package.json', content: JSON.stringify({ name: 'x', version }) },
  { name: 'local-branch-server/package-lock.json', content: '{}' },
  { name: 'local-branch-server/scripts/apply-update.ps1', content: '# updater' },
  { name: 'local-branch-server/src/server.js', content: '// server' },
  { name: 'local-branch-server/public/index.html', content: '<html></html>' },
  { name: 'local-branch-server/.env.example', content: 'PORT=4780' },
]

const makeRelease = ({ entries = goodEntries(), version = '1.5.17', tamper = false } = {}) => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
  const zipBuffer = buildZip(entries)
  const manifest = {
    version,
    channel: 'stable',
    packageUrl: `https://healthflowcloud.test/branch-updates/healthflow-branch-${version}.zip`,
    sha256: crypto.createHash('sha256').update(zipBuffer).digest('hex'),
    publishedAt: '2026-11-24T10:00:00.0000000Z',
  }
  manifest.signature = crypto.sign(null, Buffer.from(signingPayload(manifest)), privateKey).toString('base64')
  const publicPem = publicKey.export({ type: 'spki', format: 'pem' }).toString()
  return { manifest, zipBuffer: tamper ? Buffer.concat([zipBuffer, Buffer.from('x')]) : zipBuffer, publicKey: publicPem }
}

describe('update release verification', () => {
  it('uses the same signing payload as the installed updater', () => {
    const manifest = {
      version: 'v1.5.17',
      channel: 'Stable',
      packageUrl: 'https://x.test/healthflow-branch-1.5.17.zip',
      sha256: 'A'.repeat(64),
      publishedAt: '2026-11-24T10:00:00Z',
    }
    expect(signingPayload(manifest)).toBe(getManifestSigningPayload(manifest))
  })

  it('reads ZIP entries and compares versions', () => {
    const names = listZipEntries(buildZip(goodEntries())).map((entry) => entry.name)
    expect(names).toContain('local-branch-server/scripts/apply-update.ps1')
    expect(compareVersions('1.5.17', '1.5.16')).toBe(1)
    expect(compareVersions('1.5.16', '1.5.16')).toBe(0)
  })

  it('passes a correct signed release that is newer than the live one', () => {
    const release = makeRelease()
    const result = verifyUpdateRelease({ ...release, newerThan: '1.4.3' })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
  })

  it('rejects a release signed with a different key than the installers ship with', () => {
    const release = makeRelease()
    const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' }).toString()
    const result = verifyUpdateRelease({ ...release, publicKey: other })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/signature does not match/i)
  })

  it('rejects a ZIP that no longer matches the signed hash', () => {
    const result = verifyUpdateRelease({ ...makeRelease({ tamper: true }) })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/SHA-256/)
  })

  it('rejects a version that installed PCs would ignore', () => {
    const result = verifyUpdateRelease({ ...makeRelease(), newerThan: '1.5.17' })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/not newer/i)
  })

  it('rejects a package whose inner version differs from the manifest', () => {
    const result = verifyUpdateRelease({ ...makeRelease({ entries: goodEntries('1.5.16'), version: '1.5.17' }) })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/inside the ZIP is version 1\.5\.16/)
  })

  it.each([
    ['local-branch-server/.env', 'settings file'],
    ['local-branch-server/data/healthflow-branch.sqlite', 'data folder'],
    ['local-branch-server/node_modules/express/index.js', 'node_modules folder'],
    ['local-branch-server/runtime/node/node.exe', 'runtime folder'],
    ['local-branch-server/public/downloads/HealthFlow-Offline-Installer-1.4.4.zip', 'downloads folder'],
    ['local-branch-server/public/branch-updates/healthflow-branch-1.4.3.zip', 'branch-updates folder'],
    ['local-branch-server/certs/server.pfx', 'key'],
    ['local-branch-server/logs/server.log', 'logs folder'],
  ])('refuses a package that contains %s', (name, reason) => {
    const result = verifyUpdateRelease({ ...makeRelease({ entries: [...goodEntries(), { name, content: 'x' }] }) })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toContain(reason)
  })

  it('refuses a package that is missing the updater or the offline app', () => {
    const entries = goodEntries().filter((entry) => !/apply-update|index\.html/.test(entry.name))
    const result = verifyUpdateRelease({ ...makeRelease({ entries }) })
    expect(result.ok).toBe(false)
    expect(result.errors.join(' ')).toMatch(/missing scripts\/apply-update\.ps1/)
    expect(result.errors.join(' ')).toMatch(/missing public\/index\.html/)
  })
})
