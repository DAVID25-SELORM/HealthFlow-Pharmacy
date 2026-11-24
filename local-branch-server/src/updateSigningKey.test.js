import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { getManifestSigningPayload, verifyUpdateManifest } from './updateManager.js'
import {
  encryptPrivateKeyPem,
  isEncryptedPem,
  loadSigningKey,
  publicKeyDer,
} from '../scripts/update-signing-key.mjs'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const repoDir = path.resolve(serverDir, '..')

const makeKeyFile = (pem) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-key-test-'))
  const file = path.join(dir, 'key.pem')
  fs.writeFileSync(file, pem)
  return file
}
const ed25519Pem = () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519')
  return {
    plain: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    publicPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
  }
}
const PASSPHRASE = 'correct horse battery staple'

describe('update signing key protection', () => {
  it('loads a plain Ed25519 key and a passphrase-protected copy of it as the same key', async () => {
    const { plain } = ed25519Pem()
    const encrypted = encryptPrivateKeyPem(plain, PASSPHRASE)
    expect(isEncryptedPem(plain)).toBe(false)
    expect(isEncryptedPem(encrypted)).toBe(true)
    expect(encrypted).not.toContain(plain.split('\n')[1])

    const fromPlain = await loadSigningKey(makeKeyFile(plain))
    const fromEncrypted = await loadSigningKey(makeKeyFile(encrypted), { passphrase: PASSPHRASE })
    expect(Buffer.compare(publicKeyDer(fromPlain), publicKeyDer(fromEncrypted))).toBe(0)
  })

  it('asks for the passphrase on the screen when none is supplied', async () => {
    const encrypted = encryptPrivateKeyPem(ed25519Pem().plain, PASSPHRASE)
    const asked = []
    const key = await loadSigningKey(makeKeyFile(encrypted), {
      passphrase: '',
      interactive: true,
      prompt: async (question) => {
        asked.push(question)
        return PASSPHRASE
      },
    })
    expect(asked).toHaveLength(1)
    expect(key.asymmetricKeyType).toBe('ed25519')
  })

  it('refuses a wrong passphrase, and refuses to wait for typing when nobody can type', async () => {
    const file = makeKeyFile(encryptPrivateKeyPem(ed25519Pem().plain, PASSPHRASE))
    await expect(loadSigningKey(file, { passphrase: 'not the passphrase' })).rejects.toThrow(/wrong, or the key file is damaged/i)
    await expect(loadSigningKey(file, { passphrase: '', interactive: false })).rejects.toThrow(/protected by a passphrase/i)
  })

  it('refuses short passphrases, a key that is already protected, and keys that are not Ed25519', async () => {
    const { plain } = ed25519Pem()
    expect(() => encryptPrivateKeyPem(plain, 'short')).toThrow(/at least 12/i)
    expect(() => encryptPrivateKeyPem(encryptPrivateKeyPem(plain, PASSPHRASE), PASSPHRASE)).toThrow(/already protected/i)
    const rsa = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 }).privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()
    await expect(loadSigningKey(makeKeyFile(rsa))).rejects.toThrow(/must be an Ed25519 key/i)
    expect(() => encryptPrivateKeyPem(rsa, PASSPHRASE)).toThrow(/must be an Ed25519 key/i)
  })

  it('signs a manifest that the installed updater accepts', async () => {
    const { plain, publicPem } = ed25519Pem()
    const key = await loadSigningKey(makeKeyFile(encryptPrivateKeyPem(plain, PASSPHRASE)), { passphrase: PASSPHRASE })
    const manifest = {
      version: '1.5.17',
      channel: 'stable',
      packageUrl: 'https://updates.healthflow.test/healthflow-branch-1.5.17.zip',
      sha256: 'b'.repeat(64),
      publishedAt: '2026-11-24T10:00:00.0000000Z',
    }
    manifest.signature = crypto.sign(null, Buffer.from(getManifestSigningPayload(manifest)), key).toString('base64')
    expect(verifyUpdateManifest(manifest, publicPem)).toBe(true)
  })
})

describe('the update public key shipped with the product', () => {
  const fromEnvFile = (name) => {
    const text = fs.readFileSync(path.join(serverDir, name), 'utf8')
    const line = text.split(/\r?\n/).find((entry) => entry.startsWith('HEALTHFLOW_UPDATE_PUBLIC_KEY='))
    return line.replace('HEALTHFLOW_UPDATE_PUBLIC_KEY=', '').trim().split(String.fromCharCode(92) + 'n').join('\n')
  }
  const fromCloudConfig = () => {
    const text = fs.readFileSync(path.join(repoDir, 'src', 'config', 'branchUpdateConfig.js'), 'utf8')
    const body = text.match(/BRANCH_UPDATE_PUBLIC_KEY = \[([\s\S]*?)\]\.join/)[1]
    return body.split(',').map((part) => part.trim().replace(/^'|'$/g, '')).filter(Boolean).join('\n')
  }

  it('is the same valid Ed25519 public key in the Windows settings, the Linux settings and the cloud setup text', () => {
    const windows = fromEnvFile('.env.example')
    const linux = fromEnvFile('.env.linux.example')
    const cloud = fromCloudConfig()
    for (const pem of [windows, linux, cloud]) {
      expect(crypto.createPublicKey(pem).asymmetricKeyType).toBe('ed25519')
    }
    expect(linux).toBe(windows)
    expect(cloud).toBe(windows)
  })

  it('is refreshed in an existing install by the installer, without touching other settings', () => {
    const installer = fs.readFileSync(path.join(serverDir, 'scripts', 'install-service.ps1'), 'utf8').replace(/\r\n/g, '\n')
    expect(installer).toContain('function Sync-UpdateTrustKey')
    expect(installer).toContain("Set-EnvValue -Name 'HEALTHFLOW_UPDATE_PUBLIC_KEY' -Value $shipped")
    expect(installer.indexOf('Sync-UpdateTrustKey\n', installer.indexOf('Initialize-BootstrapConfiguration\n'))).toBeGreaterThan(0)
    expect(installer).not.toContain("Set-EnvValue -Name 'HEALTHFLOW_UPDATE_MANIFEST_URL'")
  })
})
