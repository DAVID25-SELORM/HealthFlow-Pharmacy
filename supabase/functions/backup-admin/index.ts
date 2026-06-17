import { createClient } from 'jsr:@supabase/supabase-js@2'
import { corsHeaders } from '../_shared/cors.ts'

const BACKUP_BUCKET = 'facility-backups'
const PAGE_SIZE = 1000
const MAX_PAGES_PER_TABLE = 100

type RequesterProfile = {
  id: string
  email: string
  role: string
  assigned_roles: string[]
  organization_id: string | null
}

type BackupTableSpec = {
  table: string
  filter: 'id' | 'organization_id' | 'seller_organization_id' | 'buyer_organization_id'
}

const BACKUP_TABLES: BackupTableSpec[] = [
  { table: 'organizations', filter: 'id' },
  { table: 'pharmacy_settings', filter: 'organization_id' },
  { table: 'branches', filter: 'organization_id' },
  { table: 'users', filter: 'organization_id' },
  { table: 'drugs', filter: 'organization_id' },
  { table: 'patients', filter: 'organization_id' },
  { table: 'sales', filter: 'organization_id' },
  { table: 'sale_items', filter: 'organization_id' },
  { table: 'claims', filter: 'organization_id' },
  { table: 'nhis_claims', filter: 'organization_id' },
  { table: 'nhis_claim_medicines', filter: 'organization_id' },
  { table: 'nhis_claim_services', filter: 'organization_id' },
  { table: 'nhis_clinical_rules', filter: 'organization_id' },
  { table: 'nhia_configuration', filter: 'organization_id' },
  { table: 'purchases', filter: 'organization_id' },
  { table: 'purchase_items', filter: 'organization_id' },
  { table: 'expenses', filter: 'organization_id' },
  { table: 'expense_categories', filter: 'organization_id' },
  { table: 'cashbook_entries', filter: 'organization_id' },
  { table: 'shifts', filter: 'organization_id' },
  { table: 'receivables', filter: 'organization_id' },
  { table: 'receivable_payments', filter: 'organization_id' },
  { table: 'audit_logs', filter: 'organization_id' },
  { table: 'epharmacy_orders', filter: 'seller_organization_id' },
  { table: 'epharmacy_order_items', filter: 'seller_organization_id' },
]

const json = (body: Record<string, unknown>, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
    },
  })

const normalizeText = (value: unknown) => (typeof value === 'string' ? value.trim() : '')

const toSafeFileName = (value: string) =>
  normalizeText(value).replace(/[^a-zA-Z0-9._-]/g, '_') || 'healthflow-online-backup.json'

const getFunctionEnv = () => {
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseAnonKey = Deno.env.get('SUPABASE_ANON_KEY')
  const serviceRoleKey =
    Deno.env.get('SERVICE_ROLE_KEY') || Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')

  if (!supabaseUrl || !supabaseAnonKey || !serviceRoleKey) {
    throw new Error(
      'Missing Supabase function environment. Set SUPABASE_URL, SUPABASE_ANON_KEY, and SERVICE_ROLE_KEY.'
    )
  }

  return { supabaseUrl, supabaseAnonKey, serviceRoleKey }
}

const createUserClient = (authorization: string, supabaseUrl: string, supabaseAnonKey: string) =>
  createClient(supabaseUrl, supabaseAnonKey, {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  })

const createAdminClient = (supabaseUrl: string, serviceRoleKey: string) =>
  createClient(supabaseUrl, serviceRoleKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  })

const requesterHasRole = (profile: RequesterProfile, roles: string[]) =>
  roles.some((role) => role === profile.role || profile.assigned_roles.includes(role))

const getRequesterProfile = async (
  adminClient: ReturnType<typeof createAdminClient>,
  userId: string,
  email = ''
): Promise<RequesterProfile | null> => {
  const { data, error } = await adminClient
    .from('users')
    .select('id, email, role, assigned_roles, organization_id')
    .eq('id', userId)
    .maybeSingle()

  if (error) throw error
  if (!data) return null

  return {
    id: data.id,
    email: data.email || email,
    role: normalizeText(data.role).toLowerCase(),
    assigned_roles: Array.isArray(data.assigned_roles)
      ? data.assigned_roles.map((role: unknown) => normalizeText(role).toLowerCase()).filter(Boolean)
      : [],
    organization_id: data.organization_id || null,
  }
}

const ensureBucket = async (adminClient: ReturnType<typeof createAdminClient>) => {
  const { data: buckets, error } = await adminClient.storage.listBuckets()
  if (error) throw error

  if ((buckets || []).some((bucket) => bucket.name === BACKUP_BUCKET)) return

  const { error: createError } = await adminClient.storage.createBucket(BACKUP_BUCKET, {
    public: false,
    fileSizeLimit: 1024 * 1024 * 250,
    allowedMimeTypes: ['application/json'],
  })
  if (createError && !String(createError.message || '').toLowerCase().includes('already exists')) {
    throw createError
  }
}

const isMissingTableOrColumn = (error: unknown) => {
  const message = String((error as any)?.message || (error as any)?.details || '').toLowerCase()
  const code = String((error as any)?.code || '')
  return (
    code === '42P01' ||
    code === '42703' ||
    code === 'PGRST204' ||
    message.includes('does not exist') ||
    message.includes('schema cache') ||
    message.includes('column')
  )
}

const readTableRows = async (
  adminClient: ReturnType<typeof createAdminClient>,
  table: string,
  filter: string,
  organizationId: string
) => {
  const rows: unknown[] = []
  for (let page = 0; page < MAX_PAGES_PER_TABLE; page += 1) {
    const from = page * PAGE_SIZE
    const to = from + PAGE_SIZE - 1
    const { data, error } = await adminClient
      .from(table)
      .select('*')
      .eq(filter, organizationId)
      .range(from, to)

    if (error) {
      if (isMissingTableOrColumn(error)) {
        return { table, rows: [], skipped: true, reason: error.message || 'Table or scope column unavailable.' }
      }
      return { table, rows: [], skipped: true, reason: error.message || 'Unable to read table.' }
    }

    const pageRows = data || []
    rows.push(...pageRows)
    if (pageRows.length < PAGE_SIZE) break
  }

  return { table, rows, skipped: false }
}

const createOnlineBackup = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile
) => {
  if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
    return json({ error: 'Only admin or super admin users can create online backups.' }, 403)
  }
  if (!requesterProfile.organization_id) {
    return json({ error: 'Admin account is missing organization context.' }, 400)
  }

  await ensureBucket(adminClient)

  const startedAt = new Date().toISOString()
  const tables: Record<string, unknown[]> = {}
  const skippedTables: Array<{ table: string; reason: string }> = []

  for (const spec of BACKUP_TABLES) {
    const result = await readTableRows(
      adminClient,
      spec.table,
      spec.filter,
      requesterProfile.organization_id
    )

    if (result.skipped) {
      skippedTables.push({ table: spec.table, reason: String(result.reason || 'Skipped') })
      continue
    }

    tables[spec.table] = result.rows
  }

  const completedAt = new Date().toISOString()
  const rowCounts = Object.fromEntries(
    Object.entries(tables).map(([table, rows]) => [table, rows.length])
  )
  const payload = {
    version: 1,
    kind: 'healthflow-online-facility-backup',
    createdAt: completedAt,
    organizationId: requesterProfile.organization_id,
    createdBy: {
      id: requesterProfile.id,
      email: requesterProfile.email,
      role: requesterProfile.role,
    },
    rowCounts,
    skippedTables,
    tables,
  }
  const content = JSON.stringify(payload, null, 2)
  const stamp = completedAt.replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z')
  const path = `${requesterProfile.organization_id}/healthflow-online-backup-${stamp}.json`

  const { error: uploadError } = await adminClient.storage
    .from(BACKUP_BUCKET)
    .upload(path, new Blob([content], { type: 'application/json' }), {
      contentType: 'application/json',
      upsert: false,
    })

  if (uploadError) throw uploadError

  return json({
    backup: {
      bucket: BACKUP_BUCKET,
      path,
      fileName: path.split('/').pop(),
      sizeBytes: new TextEncoder().encode(content).length,
      createdAt: completedAt,
      startedAt,
      rowCounts,
      skippedTables,
    },
  }, 201)
}

const listOnlineBackups = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile
) => {
  if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
    return json({ error: 'Only admin or super admin users can view online backups.' }, 403)
  }
  if (!requesterProfile.organization_id) {
    return json({ error: 'Admin account is missing organization context.' }, 400)
  }

  await ensureBucket(adminClient)
  const prefix = requesterProfile.organization_id
  const { data, error } = await adminClient.storage
    .from(BACKUP_BUCKET)
    .list(prefix, {
      limit: 20,
      sortBy: { column: 'created_at', order: 'desc' },
    })

  if (error) throw error

  return json({
    backups: (data || [])
      .filter((item) => item.name.endsWith('.json'))
      .map((item) => ({
        bucket: BACKUP_BUCKET,
        path: `${prefix}/${item.name}`,
        fileName: item.name,
        sizeBytes: item.metadata?.size || 0,
        createdAt: item.created_at || item.updated_at || null,
        updatedAt: item.updated_at || null,
      })),
  })
}

const createDownloadUrl = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
    return json({ error: 'Only admin or super admin users can download online backups.' }, 403)
  }
  if (!requesterProfile.organization_id) {
    return json({ error: 'Admin account is missing organization context.' }, 400)
  }

  const requestedPath = normalizeText(payload.path)
  const allowedPrefix = `${requesterProfile.organization_id}/`
  if (!requestedPath || !requestedPath.startsWith(allowedPrefix) || requestedPath.includes('..')) {
    return json({ error: 'Invalid backup path.' }, 400)
  }

  // 1 hour: a backup file can be large and links may be clicked/shared a little
  // later — a 60s expiry was too short and caused "token expired" download failures.
  const BACKUP_DOWNLOAD_URL_TTL_SECONDS = 60 * 60
  const { data, error } = await adminClient.storage
    .from(BACKUP_BUCKET)
    .createSignedUrl(requestedPath, BACKUP_DOWNLOAD_URL_TTL_SECONDS)

  if (error) throw error

  return json({
    signedUrl: data.signedUrl,
    fileName: requestedPath.split('/').pop() || 'healthflow-online-backup.json',
  })
}

const downloadOnlineBackup = async (
  adminClient: ReturnType<typeof createAdminClient>,
  requesterProfile: RequesterProfile,
  payload: Record<string, unknown>
) => {
  if (!requesterHasRole(requesterProfile, ['admin', 'super_admin'])) {
    return json({ error: 'Only admin or super admin users can download online backups.' }, 403)
  }
  if (!requesterProfile.organization_id) {
    return json({ error: 'Admin account is missing organization context.' }, 400)
  }

  const requestedPath = normalizeText(payload.path)
  const allowedPrefix = `${requesterProfile.organization_id}/`
  if (!requestedPath || !requestedPath.startsWith(allowedPrefix) || requestedPath.includes('..')) {
    return json({ error: 'Invalid backup path.' }, 400)
  }

  const { data, error } = await adminClient.storage
    .from(BACKUP_BUCKET)
    .download(requestedPath)

  if (error) throw error

  const fileName = toSafeFileName(requestedPath.split('/').pop() || 'healthflow-online-backup.json')
  return new Response(data, {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="${fileName}"`,
      'Access-Control-Expose-Headers': 'Content-Disposition, Content-Length',
      'Content-Length': String(data.size),
      'Cache-Control': 'no-store',
    },
  })
}

Deno.serve(async (request) => {
  if (request.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const { supabaseUrl, supabaseAnonKey, serviceRoleKey } = getFunctionEnv()
    const authorization = request.headers.get('Authorization') || ''
    if (!authorization) {
      return json({ error: 'Authorization is required.' }, 401)
    }

    const userClient = createUserClient(authorization, supabaseUrl, supabaseAnonKey)
    const adminClient = createAdminClient(supabaseUrl, serviceRoleKey)
    const { data: userData, error: userError } = await userClient.auth.getUser()
    if (userError || !userData?.user?.id) {
      return json({ error: 'Invalid or expired session.' }, 401)
    }

    const requesterProfile = await getRequesterProfile(
      adminClient,
      userData.user.id,
      userData.user.email || ''
    )
    if (!requesterProfile) {
      return json({ error: 'Unable to determine your staff permissions.' }, 403)
    }

    const payload = (await request.json().catch(() => ({}))) as Record<string, unknown>
    const action = normalizeText(payload.action)

    if (action === 'create_online_backup') {
      return await createOnlineBackup(adminClient, requesterProfile)
    }
    if (action === 'list_online_backups') {
      return await listOnlineBackups(adminClient, requesterProfile)
    }
    if (action === 'create_online_backup_download_url') {
      return await createDownloadUrl(adminClient, requesterProfile, payload)
    }
    if (action === 'download_online_backup') {
      return await downloadOnlineBackup(adminClient, requesterProfile, payload)
    }

    return json({ error: 'Unsupported backup action.' }, 400)
  } catch (error) {
    console.error('[backup-admin]', error)
    return json({ error: (error as Error)?.message || 'Online backup request failed.' }, 500)
  }
})
