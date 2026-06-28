import { db, json, nowIso, setBranchMeta } from './db.js'

const upsertUser = db.prepare(`
  INSERT INTO users (
    id, email, full_name, role, assigned_roles_json, organization_id,
    branch_id, permissions_json, is_active, updated_at
  ) VALUES (
    @id, @email, @fullName, @role, @assignedRolesJson, @organizationId,
    @branchId, @permissionsJson, @isActive, @updatedAt
  )
  ON CONFLICT(id) DO UPDATE SET
    email = excluded.email,
    full_name = excluded.full_name,
    role = excluded.role,
    assigned_roles_json = excluded.assigned_roles_json,
    organization_id = excluded.organization_id,
    branch_id = excluded.branch_id,
    permissions_json = excluded.permissions_json,
    is_active = excluded.is_active,
    updated_at = excluded.updated_at
`)

const upsertSale = db.prepare(`
  INSERT INTO sales (
    id, sale_number, remote_sale_id, remote_sale_number, patient_id,
    total_amount, discount, net_amount, payment_method, payment_status,
    amount_paid, change_given, notes, sold_by, shift_id, organization_id,
    branch_id, sale_date, created_at, synced_at, sync_status, last_sync_error
  ) VALUES (
    @id, @saleNumber, @remoteId, @saleNumber, @patientId,
    @totalAmount, @discount, @netAmount, @paymentMethod, @paymentStatus,
    @amountPaid, @changeGiven, @notes, @soldBy, @shiftId, @organizationId,
    @branchId, @saleDate, @createdAt, @syncedAt, 'synced', NULL
  )
  ON CONFLICT(id) DO UPDATE SET
    sale_number = excluded.sale_number,
    remote_sale_id = excluded.remote_sale_id,
    remote_sale_number = excluded.remote_sale_number,
    patient_id = excluded.patient_id,
    total_amount = excluded.total_amount,
    discount = excluded.discount,
    net_amount = excluded.net_amount,
    payment_method = excluded.payment_method,
    payment_status = excluded.payment_status,
    amount_paid = excluded.amount_paid,
    change_given = excluded.change_given,
    notes = excluded.notes,
    sold_by = excluded.sold_by,
    shift_id = excluded.shift_id,
    organization_id = excluded.organization_id,
    branch_id = excluded.branch_id,
    sale_date = excluded.sale_date,
    synced_at = excluded.synced_at,
    sync_status = CASE WHEN sales.sync_status IN ('pending', 'failed') THEN sales.sync_status ELSE 'synced' END,
    last_sync_error = CASE WHEN sales.sync_status IN ('pending', 'failed') THEN sales.last_sync_error ELSE NULL END
`)

const findExistingSale = db.prepare(`
  SELECT id
  FROM sales
  WHERE id = @remoteId
     OR remote_sale_id = @remoteId
     OR remote_sale_number = @saleNumber
     OR sale_number = @saleNumber
  LIMIT 1
`)
const deleteSaleItems = db.prepare('DELETE FROM sale_items WHERE sale_id = ?')
const insertSaleItem = db.prepare(`
  INSERT INTO sale_items (
    id, sale_id, drug_id, drug_name, quantity, unit_price, total_price, created_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
`)

const permissionFields = [
  'can_refund', 'can_manage_inventory', 'can_view_reports', 'can_manage_claims',
  'can_manage_purchases', 'can_process_sales', 'can_manage_patients',
  'can_manage_accounting', 'can_manage_epharmacy', 'can_view_activity_log',
  'can_adjust_stock', 'can_approve_purchases', 'can_delete_nhis_claims',
]

export const importUsersSnapshot = db.transaction((rows = []) => {
  const timestamp = nowIso()
  let imported = 0
  for (const row of rows) {
    if (!row?.id) continue
    const permissions = Object.fromEntries(
      permissionFields.map((field) => [field, Boolean(row[field])])
    )
    upsertUser.run({
      id: row.id,
      email: row.email || null,
      fullName: row.full_name || row.email || 'Staff member',
      role: row.role || 'assistant',
      assignedRolesJson: json(row.assigned_roles || [row.role].filter(Boolean)),
      organizationId: row.organization_id || null,
      branchId: row.branch_id || null,
      permissionsJson: json(permissions),
      isActive: row.is_active === false ? 0 : 1,
      updatedAt: row.updated_at || timestamp,
    })
    imported += 1
  }
  return { imported }
})

export const importSalesSnapshot = db.transaction((rows = []) => {
  const timestamp = nowIso()
  let imported = 0
  for (const row of rows) {
    if (!row?.id || !row.sale_number) continue
    const existing = findExistingSale.get({ remoteId: row.id, saleNumber: row.sale_number })
    const localSaleId = existing?.id || row.id
    upsertSale.run({
      id: localSaleId,
      remoteId: row.id,
      saleNumber: row.sale_number,
      patientId: row.patient_id || null,
      totalAmount: Number(row.total_amount || 0),
      discount: Number(row.discount || 0),
      netAmount: Number(row.net_amount || 0),
      paymentMethod: row.payment_method || 'cash',
      paymentStatus: row.payment_status || 'completed',
      amountPaid: row.amount_paid == null ? null : Number(row.amount_paid),
      changeGiven: row.change_given == null ? null : Number(row.change_given),
      notes: row.notes || null,
      soldBy: row.sold_by || null,
      shiftId: row.shift_id || null,
      organizationId: row.organization_id || null,
      branchId: row.branch_id || null,
      saleDate: row.sale_date || row.created_at || timestamp,
      createdAt: row.created_at || timestamp,
      syncedAt: timestamp,
    })
    deleteSaleItems.run(localSaleId)
    for (const item of row.sale_items || []) {
      if (!item?.id) continue
      insertSaleItem.run(
        item.id, localSaleId, item.drug_id || `historical:${item.id}`, item.drug_name || 'Medicine',
        Number(item.quantity || 0), Number(item.unit_price || 0),
        Number(item.total_price || 0), item.created_at || timestamp
      )
    }
    imported += 1
  }
  return { imported }
})

export const importMetadataSnapshot = (key, rows = []) => {
  setBranchMeta(key, json(rows))
  return { imported: rows.length }
}
