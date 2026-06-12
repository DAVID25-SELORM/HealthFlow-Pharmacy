import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const updateArtifactsDir = path.join(
  repoDir,
  'local-branch-server',
  'public',
  'branch-updates'
)

fs.rmSync(updateArtifactsDir, { recursive: true, force: true })
