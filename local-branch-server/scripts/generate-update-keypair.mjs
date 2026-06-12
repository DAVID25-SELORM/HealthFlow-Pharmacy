import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

const outputDir = path.resolve(process.argv[2] || process.cwd())
fs.mkdirSync(outputDir, { recursive: true })

const privateKeyPath = path.join(outputDir, 'healthflow-update-private.pem')
const publicKeyPath = path.join(outputDir, 'healthflow-update-public.pem')
if (fs.existsSync(privateKeyPath) || fs.existsSync(publicKeyPath)) {
  throw new Error('Update key files already exist in the selected directory.')
}

const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519')
fs.writeFileSync(
  privateKeyPath,
  privateKey.export({ type: 'pkcs8', format: 'pem' }),
  { encoding: 'utf8', mode: 0o600 }
)
fs.writeFileSync(
  publicKeyPath,
  publicKey.export({ type: 'spki', format: 'pem' }),
  'utf8'
)

console.log(`Private key: ${privateKeyPath}`)
console.log(`Public key:  ${publicKeyPath}`)
