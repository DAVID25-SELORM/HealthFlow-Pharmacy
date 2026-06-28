const appUrl = (process.env.HEALTHFLOW_APP_URL || 'https://healthflowcloud.com').replace(/\/+$/, '')
const supabaseUrl = (
  process.env.HEALTHFLOW_SUPABASE_URL ||
  'https://bcvmiwmhtvtqrvzdovin.supabase.co'
).replace(/\/+$/, '')

const timeoutMs = Number(process.env.HEALTHFLOW_MONITOR_TIMEOUT_MS || 15000)
const failures = []

const fetchJson = async (label, url, { optional = false, ...options } = {}) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const text = await response.text()
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${text.slice(0, 180)}`)
    }

    const contentType = response.headers.get('content-type') || ''
    if (!contentType.includes('application/json')) {
      throw new Error(`Expected JSON but received ${contentType || 'an unknown content type'}.`)
    }
    const payload = text ? JSON.parse(text) : {}
    console.log(`[OK] ${label} (${Date.now() - startedAt} ms)`)
    return payload
  } catch (error) {
    if (optional) {
      console.warn(`[WARN] ${label}: ${error.message}`)
    } else {
      failures.push(`${label}: ${error.message}`)
      console.error(`[FAIL] ${label}: ${error.message}`)
    }
    return null
  } finally {
    clearTimeout(timeout)
  }
}

const fetchPage = async (label, url) => {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)
  const startedAt = Date.now()

  try {
    const response = await fetch(url, { signal: controller.signal, redirect: 'follow' })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    console.log(`[OK] ${label} (${Date.now() - startedAt} ms)`)
  } catch (error) {
    failures.push(`${label}: ${error.message}`)
    console.error(`[FAIL] ${label}: ${error.message}`)
  } finally {
    clearTimeout(timeout)
  }
}

await fetchPage('HealthFlow Cloud', appUrl)
await fetchJson('Claim bridge', `${appUrl}/api/json-api/health`)
await fetchJson('HMS API', `${appUrl}/api/hms-api/health`)
await fetchJson('Branch update manifest', `${appUrl}/branch-updates/manifest.json`)

const publishableKey =
  process.env.HEALTHFLOW_SUPABASE_PUBLISHABLE_KEY ||
  process.env.VITE_SUPABASE_PUBLISHABLE_KEY
const email = process.env.HEALTHFLOW_MONITOR_EMAIL
const password = process.env.HEALTHFLOW_MONITOR_PASSWORD

if (publishableKey) {
  await fetchJson('Supabase Auth', `${supabaseUrl}/auth/v1/health`, {
    headers: { apikey: publishableKey },
  })
} else {
  console.log('[SKIP] Supabase Auth: publishable key is not configured.')
}

if (publishableKey && email && password) {
  const auth = await fetchJson('Monitor login', `${supabaseUrl}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: {
      apikey: publishableKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ email, password }),
  })

  if (auth?.access_token) {
    await fetchJson('Authenticated report probe', `${supabaseUrl}/functions/v1/tier-access`, {
      method: 'POST',
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${auth.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ action: 'get_report_health' }),
    })
  }
} else {
  console.log('[SKIP] Authenticated login/report probe: monitoring secrets are not configured.')
}

if (failures.length) {
  console.error(`\nProduction health check failed:\n- ${failures.join('\n- ')}`)
  process.exit(1)
}

console.log('\nProduction health checks passed.')
