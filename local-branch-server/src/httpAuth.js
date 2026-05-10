import { config } from './config.js'

export const requireBranchToken = (request, response, next) => {
  const token = request.get('x-branch-token') || ''

  if (!config.branchServerToken || token !== config.branchServerToken) {
    response.status(401).json({ error: 'Branch server token is invalid or missing.' })
    return
  }

  next()
}
