// Locks the update signing key with a passphrase. Run it yourself in a terminal; the passphrase is typed on the
// screen with nothing shown and is never saved. The plain key file is NOT deleted: delete it yourself after the
// encrypted copy has been backed up and tested.
//
//   node protect-update-key.mjs <plain-private-key.pem> [<encrypted-output.pem>]
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MIN_PASSPHRASE_LENGTH,
  encryptPrivateKeyPem,
  loadSigningKey,
  publicKeyDer,
  readHiddenLine,
} from './update-signing-key.mjs'

const main = async () => {
  const [input, requestedOutput] = process.argv.slice(2)
  if (!input) {
    console.error('Usage: node protect-update-key.mjs <plain-private-key.pem> [<encrypted-output.pem>]')
    process.exit(2)
  }
  if (!process.stdin.isTTY) {
    console.error('Run this in a terminal so you can type the passphrase on the screen.')
    process.exit(2)
  }
  const output = requestedOutput || input.replace(/\.pem$/i, '') + '.encrypted.pem'
  if (fs.existsSync(output)) {
    console.error(`${output} already exists. It is never overwritten.`)
    process.exit(1)
  }

  const plainPem = fs.readFileSync(input, 'utf8')
  const first = await readHiddenLine(`New passphrase (at least ${MIN_PASSPHRASE_LENGTH} characters): `)
  const second = await readHiddenLine('Type it again: ')
  if (first !== second) {
    console.error('The two passphrases are not the same. Nothing was written.')
    process.exit(1)
  }
  const encrypted = encryptPrivateKeyPem(plainPem, first)
  fs.writeFileSync(output, encrypted, { encoding: 'utf8', mode: 0o600, flag: 'wx' })

  // Prove the new file works before anyone deletes the plain one: it must open with the passphrase and be the same key.
  const reopened = await loadSigningKey(output, { passphrase: first })
  const same = Buffer.compare(publicKeyDer(reopened), publicKeyDer(crypto.createPrivateKey(plainPem))) === 0
  if (!same) {
    fs.rmSync(output, { force: true })
    console.error('The protected copy did not match the original, so it was removed. Nothing was changed.')
    process.exit(1)
  }
  console.log(`Protected key written: ${path.resolve(output)}`)
  console.log('It opens with your passphrase and is the same key as the original.')
  console.log('Next: back up the protected file in two places, store the passphrase somewhere separate from it,')
  console.log(`then delete the plain file yourself: ${path.resolve(input)}`)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message)
    process.exit(1)
  })
}
