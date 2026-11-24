import crypto from 'node:crypto'
import fs from 'node:fs'
import { loadSigningKey } from './update-signing-key.mjs'

const [manifestPath, privateKeyPath] = process.argv.slice(2)
if (!manifestPath || !privateKeyPath) {
  throw new Error('Usage: node sign-update-manifest.mjs <manifest-path> <private-key-path>')
}

const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8').replace(/^﻿/, ''))
// A key protected by a passphrase asks for it on the screen (or reads HEALTHFLOW_UPDATE_KEY_PASSPHRASE).
const privateKey = await loadSigningKey(privateKeyPath)
const payload = [
  String(manifest.version || '').trim().replace(/^v/i, ''),
  String(manifest.channel || 'stable').trim().toLowerCase(),
  String(manifest.packageUrl || '').trim(),
  String(manifest.sha256 || '').trim().toLowerCase(),
  String(manifest.publishedAt || '').trim(),
].join('\n')

manifest.signature = crypto
  .sign(null, Buffer.from(payload, 'utf8'), privateKey)
  .toString('base64')

fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
