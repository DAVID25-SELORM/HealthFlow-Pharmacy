// A tiny stand-in for the cloud backend so the real, built app can be opened in a
// real browser during CI without touching production or any network.
//
// Every request to the fake cloud host is answered here. Anything we do not know
// about gets an empty list, which is how an empty pharmacy looks to the app.

export const FAKE_CLOUD_ORIGIN = 'https://guard-test.supabase.co'
export const FAKE_STORAGE_KEY = 'sb-guard-test-auth-token'

const base64Url = (value) =>
  Buffer.from(JSON.stringify(value)).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

const FAR_FUTURE = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30

const fakeJwt = (userId) =>
  [
    base64Url({ alg: 'HS256', typ: 'JWT' }),
    base64Url({ sub: userId, role: 'authenticated', aud: 'authenticated', exp: FAR_FUTURE }),
    'guard-test-signature',
  ].join('.')

const ORGANIZATION = {
  id: 'org-guard-1',
  name: 'Guard Test Pharmacy',
  status: 'active',
  organization_type: 'pharmacy',
  plan_code: 'professional',
  billing_status: 'active',
  support_level: 'standard',
  can_use_claims: true,
  can_use_purchases: true,
  can_use_nhis: true,
  can_use_nhis_topups: false,
  nhis_top_up_policy: 'none',
  can_use_accounting: true,
  can_use_multi_branch: false,
  can_use_offline_installer: false,
  interface_flags: {},
}

const BRANCH = { id: 'branch-guard-1', name: 'Main Branch', code: 'MAIN', is_main: true }

const MEDICINES = Array.from({ length: 8 }, (_, index) => ({
  id: `med-${index + 1}`,
  organization_id: ORGANIZATION.id,
  name: `Test Medicine ${index + 1} 500mg`,
  generic_name: `Generic ${index + 1}`,
  category: 'Tablet',
  quantity: 40 + index,
  unit_price: 5 + index,
  cost_price: 3 + index,
  reorder_level: 10,
  expiry_date: '2028-12-31',
  is_active: true,
}))

const ROLE_PROFILES = {
  admin: {
    role: 'admin',
    assigned_roles: ['admin'],
    can_refund: true,
    can_manage_inventory: true,
    can_view_reports: true,
    can_manage_claims: true,
    can_manage_purchases: true,
    can_process_sales: true,
    can_manage_patients: true,
    can_manage_accounting: true,
    can_manage_epharmacy: true,
    can_view_activity_log: true,
    can_adjust_stock: true,
    can_approve_purchases: true,
    can_delete_nhis_claims: true,
    can_manage_restricted_inventory: false,
  },
  cashier: {
    role: 'cashier',
    assigned_roles: ['cashier'],
    can_refund: false,
    can_manage_inventory: false,
    can_view_reports: false,
    can_manage_claims: false,
    can_manage_purchases: false,
    can_process_sales: true,
    can_manage_patients: false,
    can_manage_accounting: false,
    can_manage_epharmacy: false,
    can_view_activity_log: false,
    can_adjust_stock: false,
    can_approve_purchases: false,
    can_delete_nhis_claims: false,
    can_manage_restricted_inventory: false,
  },
}

export const buildProfile = (roleName) => {
  const userId = `user-guard-${roleName}`
  return {
    id: userId,
    email: `${roleName}@guard.test`,
    full_name: `Guard ${roleName}`,
    is_active: true,
    organization_id: ORGANIZATION.id,
    branch_id: BRANCH.id,
    ...ROLE_PROFILES[roleName],
  }
}

const buildAuthUser = (profile) => ({
  id: profile.id,
  aud: 'authenticated',
  role: 'authenticated',
  email: profile.email,
  email_confirmed_at: '2026-01-01T00:00:00Z',
  app_metadata: { provider: 'email' },
  user_metadata: { full_name: profile.full_name },
  created_at: '2026-01-01T00:00:00Z',
})

export const buildSession = (roleName) => {
  const profile = buildProfile(roleName)
  return {
    access_token: fakeJwt(profile.id),
    refresh_token: 'guard-refresh-token',
    token_type: 'bearer',
    expires_in: 60 * 60 * 24 * 30,
    expires_at: FAR_FUTURE,
    user: buildAuthUser(profile),
  }
}

const jsonResponse = (body, status = 200, headers = {}) => ({
  status,
  contentType: 'application/json',
  headers: { 'access-control-allow-origin': '*', ...headers },
  body: JSON.stringify(body),
})

const CORS_HEADERS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': '*',
  'access-control-expose-headers': '*',
}

const TABLE_ROWS = (roleName, organization = ORGANIZATION) => ({
  users: [buildProfile(roleName)],
  organizations: [organization],
  branches: [BRANCH],
  drugs: MEDICINES,
  medicines: MEDICINES,
  inventory: MEDICINES,
  products: MEDICINES,
})

// Installs the fake cloud on a Playwright page and signs the given role in.
// `interfaceFlags` are the per-pharmacy interface switches, e.g. { classic_navigation: true }.
export const installFakeBackend = async (page, roleName = 'admin', { interfaceFlags = {} } = {}) => {
  const rows = TABLE_ROWS(roleName, { ...ORGANIZATION, interface_flags: interfaceFlags })
  const session = buildSession(roleName)
  const profile = buildProfile(roleName)

  await page.addInitScript(
    ({ key, value }) => {
      try {
        window.localStorage.setItem(key, JSON.stringify(value))
      } catch {
        // Storage can be blocked; the test will then fail loudly at the sign-in screen.
      }
    },
    { key: FAKE_STORAGE_KEY, value: session }
  )

  await page.route(`${FAKE_CLOUD_ORIGIN}/**`, async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    const method = request.method()

    if (method === 'OPTIONS') {
      return route.fulfill({ status: 204, headers: CORS_HEADERS })
    }

    if (url.pathname.startsWith('/auth/v1/')) {
      if (url.pathname.endsWith('/user')) return route.fulfill(jsonResponse(session.user))
      if (url.pathname.endsWith('/token')) return route.fulfill(jsonResponse(session))
      return route.fulfill(jsonResponse({}))
    }

    if (url.pathname.startsWith('/rest/v1/rpc/')) {
      return route.fulfill(jsonResponse([]))
    }

    if (url.pathname.startsWith('/rest/v1/')) {
      const table = url.pathname.replace('/rest/v1/', '')
      const tableRows = rows[table] || []
      const wantsSingleObject = String(request.headers().accept || '').includes('vnd.pgrst.object')
      const countHeader = { 'content-range': `0-${Math.max(tableRows.length - 1, 0)}/${tableRows.length}` }

      if (method === 'HEAD') return route.fulfill({ status: 200, headers: { ...CORS_HEADERS, ...countHeader } })
      if (method !== 'GET') return route.fulfill(jsonResponse(tableRows.slice(0, 1), 201, countHeader))
      if (wantsSingleObject) {
        return tableRows.length
          ? route.fulfill(jsonResponse(tableRows[0], 200, countHeader))
          : route.fulfill(jsonResponse({ code: 'PGRST116', message: 'The result contains 0 rows', details: null, hint: null }, 406))
      }
      return route.fulfill(jsonResponse(tableRows, 200, countHeader))
    }

    if (url.pathname.startsWith('/functions/v1/')) return route.fulfill(jsonResponse({}))
    if (url.pathname.startsWith('/storage/v1/')) return route.fulfill(jsonResponse([]))

    return route.fulfill(jsonResponse({}))
  })

  // Realtime sockets cannot be faked cheaply; the app copes without them.
  await page.routeWebSocket(/guard-test\.supabase\.co/, (socket) => socket.close())

  return { profile, session }
}
