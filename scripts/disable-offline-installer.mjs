#!/usr/bin/env node
import fs from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

const INSTALLER_ENV_NAMES = ['VITE_HEALTHFLOW_INSTALLER_URL', 'HEALTHFLOW_INSTALLER_URL']

export async function disableInstallerInEnvFile(envFilePath) {
  const resolvedPath = path.resolve(envFilePath)
  const original = await fs.readFile(resolvedPath, 'utf8')
  const lines = original.split(/\r?\n/)
  let removed = 0
  const nextLines = lines.filter((line) => {
    const trimmed = line.trim()
    const shouldRemove = INSTALLER_ENV_NAMES.some((name) => trimmed.startsWith(`${name}=`))
    if (shouldRemove) removed += 1
    return !shouldRemove
  })

  if (removed > 0) {
    const newline = original.includes('\r\n') ? '\r\n' : '\n'
    await fs.writeFile(resolvedPath, nextLines.join(newline), 'utf8')
  }

  return { envFilePath: resolvedPath, removed }
}

export function getDisableSummary(result = null) {
  const lines = [
    '',
    'HealthFlow offline installer downloads',
    '--------------------------------------',
  ]

  if (result) {
    lines.push(
      result.removed > 0
        ? `Removed installer URL from ${result.envFilePath}.`
        : `No installer URL was found in ${result.envFilePath}.`
    )
  } else {
    lines.push('No env file was provided, so no local file was changed.')
  }

  lines.push(
    '',
    'To disable downloads in production now:',
    '1. Remove VITE_HEALTHFLOW_INSTALLER_URL from the production environment.',
    '2. Redeploy HealthFlow.',
    '3. Confirm Offline Sync says installer downloads are unavailable.',
    '',
    'The installer ZIP is not deleted. Keep it for rollback or later re-enablement.',
    ''
  )

  return lines.join('\n')
}

async function main() {
  const envFileIndex = process.argv.findIndex((arg) => arg === '--env-file')
  const envFilePath =
    envFileIndex >= 0 ? process.argv[envFileIndex + 1] : process.env.HEALTHFLOW_INSTALLER_ENV_FILE

  try {
    const result = envFilePath ? await disableInstallerInEnvFile(envFilePath) : null
    console.log(getDisableSummary(result))
  } catch (error) {
    console.error('')
    console.error('Unable to disable offline installer downloads')
    console.error('---------------------------------------------')
    console.error(error.message)
    console.error('')
    process.exitCode = 1
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main()
}
