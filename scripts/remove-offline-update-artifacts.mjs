import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const publicDir = path.join(repoDir, 'local-branch-server', 'public')

// The web build copies everything from the website's public folder. Neither the signed update packages
// (branch-updates) nor the downloadable installer ZIP (downloads, tens of MB) belongs inside the offline app:
// they would be packed into every installer and every update.
for (const folder of ['branch-updates', 'downloads']) {
  fs.rmSync(path.join(publicDir, folder), { recursive: true, force: true })
}
