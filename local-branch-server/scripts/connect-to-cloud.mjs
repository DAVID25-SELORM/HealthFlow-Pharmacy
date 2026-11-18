#!/usr/bin/env node
// Reads a Branch Sync Setup block on standard input and saves the cloud connection into this server's
// .env, using the same function (saveCloudSyncSettings) the app's "Apply facility connection" button uses.
// It prints ids and the cloud address only, never a token or key.
//
// Exit codes: 0 saved, 2 the block was not usable (nothing was changed), 1 unexpected failure.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseSetupBlock, SetupBlockError, summarizeSetup } from '../src/cloudSetupBlock.js'

const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const envPath = process.env.HEALTHFLOW_ENV_PATH
  ? path.resolve(process.env.HEALTHFLOW_ENV_PATH)
  : path.join(serverDir, '.env')

const refuse = (message) => {
  console.error(`NOT SAVED: ${message}`)
  console.error('Nothing was changed.')
  process.exit(2)
}

const readStdin = async () => {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

let input
try {
  input = parseSetupBlock(await readStdin())
} catch (error) {
  if (error instanceof SetupBlockError) refuse(error.message)
  throw error
}

// One rolling copy of the .env as it was, in case the technician needs to go back.
if (fs.existsSync(envPath)) {
  fs.copyFileSync(envPath, `${envPath}.before-cloud-connect`)
  fs.chmodSync(`${envPath}.before-cloud-connect`, 0o600)
}

try {
  // Keep dotenv's "injected env" notices off the technician's screen.
  process.env.DOTENV_CONFIG_QUIET ??= 'true'
  // Loaded only now, so an unusable block never reaches the server's configuration code.
  const { saveCloudSyncSettings } = await import('../src/tlsSettings.js')
  saveCloudSyncSettings(input)
} catch (error) {
  if (error?.status === 400) refuse(error.message)
  throw error
}

const summary = summarizeSetup(input)
console.log('Saved the cloud connection for this computer.')
console.log(`  Organization: ${summary.organizationId}`)
console.log(`  Branch:       ${summary.branchId}`)
console.log(`  Cloud:        ${summary.cloudHost}`)
console.log('  Sync token and key: received and stored (not shown)')
console.log(`  Settings file: ${envPath}`)
