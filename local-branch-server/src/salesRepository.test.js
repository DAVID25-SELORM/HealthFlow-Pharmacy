import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('local POS shift enforcement', () => {
  it('rejects sales before explicit opening and after closing the session', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-pos-shift-'))
    const dbUrl = pathToFileURL(path.resolve('local-branch-server/src/db.js')).href
    const salesUrl = pathToFileURL(
      path.resolve('local-branch-server/src/salesRepository.js')
    ).href
    const script = `
      const { db, closeDatabase } = await import(${JSON.stringify(dbUrl)});
      const sales = await import(${JSON.stringify(salesUrl)});
      db.prepare(\`
        INSERT INTO drugs (id, name, quantity, price, branch_id)
        VALUES ('drug-1', 'Test medicine', 10, 2.5, 'branch-1')
      \`).run();
      const payload = {
        items: [{ drugId: 'drug-1', name: 'Test medicine', quantity: 1, price: 2.5 }],
        paymentMethod: 'cash', amountPaid: 2.5, soldBy: 'staff-1',
        organizationId: 'org-1', branchId: 'branch-1'
      };
      let beforeOpen = '';
      try { sales.createLocalSale(payload); } catch (error) { beforeOpen = error.message; }
      const session = sales.openLocalPosSession({
        userId: 'staff-1', organizationId: 'org-1', branchId: 'branch-1', openingCash: 10
      });
      const completed = sales.createLocalSale({ ...payload, shiftId: session.id });
      sales.closeLocalPosSession({
        id: session.id, userId: 'staff-1', countedCash: 12.5
      });
      let afterClose = '';
      try {
        sales.createLocalSale({ ...payload, shiftId: session.id });
      } catch (error) { afterClose = error.message; }
      console.log(JSON.stringify({ beforeOpen, session, completed, afterClose }));
      closeDatabase();
    `

    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'),
        env: {
          ...process.env,
          HEALTHFLOW_DB_PATH: path.join(directory, 'branch.sqlite'),
          ORGANIZATION_ID: 'org-1',
          BRANCH_ID: 'branch-1',
        },
        encoding: 'utf8',
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))
      expect(result.beforeOpen).toContain('Open a POS shift')
      expect(result.session).toMatchObject({
        userId: 'staff-1',
        branchId: 'branch-1',
        status: 'open',
      })
      expect(result.completed.sale.shiftId).toBe(result.session.id)
      expect(result.afterClose).toContain('not open')
    } finally {
      fs.rmSync(directory, { recursive: true, force: true })
    }
  })
})
