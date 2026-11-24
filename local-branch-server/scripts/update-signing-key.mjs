// Loading and protecting the update signing key. The private key signs every update that offline PCs will trust,
// so it can be kept encrypted with a passphrase. The passphrase is asked for on the screen (hidden) or, for
// automation, read from HEALTHFLOW_UPDATE_KEY_PASSPHRASE. It is never written anywhere.
import crypto from 'node:crypto'
import fs from 'node:fs'
import readline from 'node:readline'

export const MIN_PASSPHRASE_LENGTH = 12

export const isEncryptedPem = (pem) => /-----BEGIN ENCRYPTED PRIVATE KEY-----/.test(String(pem))

export const readHiddenLine = (question) =>
  new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })
    let muted = false
    rl._writeToOutput = (text) => {
      if (!muted) process.stdout.write(text)
    }
    rl.question(question, (answer) => {
      rl.close()
      process.stdout.write('\n')
      resolve(answer)
    })
    muted = true
  })

const assertEd25519 = (key) => {
  if (key.asymmetricKeyType !== 'ed25519') {
    throw new Error(`The update signing key must be an Ed25519 key, but this one is ${key.asymmetricKeyType}.`)
  }
  return key
}

// Returns a private KeyObject from a plain or passphrase-protected PEM file.
export const loadSigningKey = async (
  keyPath,
  { passphrase = process.env.HEALTHFLOW_UPDATE_KEY_PASSPHRASE, prompt = readHiddenLine, interactive = Boolean(process.stdin.isTTY) } = {}
) => {
  const pem = fs.readFileSync(keyPath, 'utf8')
  if (!isEncryptedPem(pem)) {
    return assertEd25519(crypto.createPrivateKey(pem))
  }
  let secret = passphrase
  if (!secret) {
    if (!interactive) {
      throw new Error('The signing key is protected by a passphrase. Run this in a terminal to type it, or set HEALTHFLOW_UPDATE_KEY_PASSPHRASE.')
    }
    secret = await prompt('Signing key passphrase: ')
  }
  let key
  try {
    key = crypto.createPrivateKey({ key: pem, passphrase: secret })
  } catch {
    throw new Error('The signing key passphrase is wrong, or the key file is damaged.')
  }
  return assertEd25519(key)
}

// Re-encodes a plain Ed25519 private key PEM as a passphrase-protected one (PKCS#8, AES-256).
export const encryptPrivateKeyPem = (plainPem, passphrase) => {
  if (String(passphrase || '').length < MIN_PASSPHRASE_LENGTH) {
    throw new Error(`Use a passphrase of at least ${MIN_PASSPHRASE_LENGTH} characters.`)
  }
  if (isEncryptedPem(plainPem)) throw new Error('This key file is already protected by a passphrase.')
  const key = assertEd25519(crypto.createPrivateKey(plainPem))
  return key.export({ type: 'pkcs8', format: 'pem', cipher: 'aes-256-cbc', passphrase })
}

export const publicKeyDer = (key) =>
  crypto.createPublicKey(key).export({ type: 'spki', format: 'der' })
