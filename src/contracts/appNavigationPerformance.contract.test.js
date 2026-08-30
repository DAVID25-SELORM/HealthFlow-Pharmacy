import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const app = readFileSync(resolve(process.cwd(), 'src/App.jsx'), 'utf8')
const sidebar = readFileSync(resolve(process.cwd(), 'src/components/Layout/Sidebar.jsx'), 'utf8')
const topBar = readFileSync(resolve(process.cwd(), 'src/components/Layout/TopBar.jsx'), 'utf8')
const routeModules = readFileSync(resolve(process.cwd(), 'src/routes/routeModules.js'), 'utf8')

describe('application navigation performance contract', () => {
  it('shares cached lazy route loaders and prefetches authorized destinations on intent', () => {
    expect(app).toContain("loadRouteModule('/inventory')")
    expect(app).toContain("loadRouteModule('/nhis')")
    expect(routeModules).toContain('const routeModulePromises = new Map()')
    expect(sidebar).toContain('onMouseEnter={() => preloadRouteModule(item.path)}')
    expect(sidebar).toContain('onFocus={() => preloadRouteModule(item.path)}')
    expect(sidebar).toContain('onTouchStart={() => preloadRouteModule(item.path)}')
  })

  it('defers noncritical shell requests so route data receives startup priority', () => {
    expect(topBar).toContain('scheduleNonCriticalWork')
    expect(topBar).toContain('void loadAlerts()')
    expect(topBar).toContain('subscribeSystemHealthPolling(')
    expect(topBar).toContain('void refreshConnectivityState()')
  })
})
