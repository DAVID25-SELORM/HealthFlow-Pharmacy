import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('cloud snapshot imports', () => {
  it('caches staff and reconciles a cloud sale with its existing local row', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-snapshot-'))
    const dbUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const repositoryUrl = pathToFileURL(
      path.resolve('local-branch-server/src/cloudSnapshotRepository.js')
    ).href
    const script = `
      const { db, closeDatabase } = await import(${JSON.stringify(dbUrl)});
      const { importUsersSnapshot, importSalesSnapshot } = await import(${JSON.stringify(repositoryUrl)});
      importUsersSnapshot([{
        id: 'staff-1', email: 'staff@example.com', full_name: 'Staff One',
        role: 'cashier', assigned_roles: ['cashier'], organization_id: 'org-1',
        branch_id: 'branch-1', is_active: true, can_refund: true
      }]);
      db.prepare(\`
        INSERT INTO sales (
          id, sale_number, remote_sale_id, remote_sale_number, total_amount,
          net_amount, payment_method, payment_status, sale_date, sync_status
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      \`).run('local-sale', 'BR-001', 'remote-sale', 'BR-001', 10, 10, 'cash', 'completed', '2026-06-01', 'synced');
      importSalesSnapshot([{
        id: 'remote-sale', sale_number: 'BR-001', total_amount: 12, net_amount: 12,
        payment_method: 'cash', payment_status: 'completed', sale_date: '2026-06-01',
        organization_id: 'org-1', branch_id: 'branch-1',
        sale_items: [{ id: 'item-1', drug_id: null, drug_name: 'Historic item', quantity: 1, unit_price: 12, total_price: 12 }]
      }]);
      const result = {
        user: db.prepare('SELECT id, assigned_roles_json, permissions_json FROM users WHERE id = ?').get('staff-1'),
        sales: db.prepare('SELECT id, remote_sale_id, net_amount FROM sales').all(),
        item: db.prepare('SELECT sale_id, drug_id FROM sale_items WHERE id = ?').get('item-1')
      };
      closeDatabase();
      console.log(JSON.stringify(result));
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite'),
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))

      expect(result.user).toMatchObject({ id: 'staff-1' })
      expect(JSON.parse(result.user.assigned_roles_json)).toEqual(['cashier'])
      expect(JSON.parse(result.user.permissions_json).can_refund).toBe(true)
      expect(result.sales).toEqual([{ id: 'local-sale', remote_sale_id: 'remote-sale', net_amount: 12 }])
      expect(result.item).toEqual({
        sale_id: 'local-sale',
        drug_id: 'historical:item-1',
      })
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
