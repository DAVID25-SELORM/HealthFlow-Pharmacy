import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

describe('isolated outage recovery', () => {
  it('retains a cash sale through a cloud outage and uploads it once after retry becomes due', () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'healthflow-outage-'))
    const moduleUrl = (name) => JSON.stringify(pathToFileURL(path.resolve('local-branch-server/src', name)).href)
    const script = `
      const { db, closeDatabase } = await import(${moduleUrl('db.js')});
      const sales = await import(${moduleUrl('salesRepository.js')});
      const { syncPendingOutbox } = await import(${moduleUrl('supabaseSync.js')});
      let online = false;
      const received = [];
      globalThis.fetch = async (url, options) => {
        if (!String(url).endsWith('/rpc/branch_sync_create_sale_transaction')) throw new Error('Unexpected network request');
        if (!online) return new Response(JSON.stringify({message:'Service unavailable'}), {status:503,headers:{'Content-Type':'application/json'}});
        const payload = JSON.parse(options.body);
        received.push(payload.p_local_sale_id);
        return new Response(JSON.stringify({sale_id:'cloud-sale',sale_number:'TEST-1'}), {status:200,headers:{'Content-Type':'application/json'}});
      };
      db.prepare("INSERT INTO drugs (id, name, quantity, price, branch_id) VALUES ('drug-test', 'Test only', 10, 2.5, 'branch-test')").run();
      const shift = sales.openLocalPosSession({userId:'staff-test',organizationId:'org-test',branchId:'branch-test',openingCash:0});
      const created = sales.createLocalSale({items:[{drugId:'drug-test',name:'Test only',quantity:2,price:2.5}],paymentMethod:'cash',amountPaid:5,soldBy:'staff-test',organizationId:'org-test',branchId:'branch-test',shiftId:shift.id});
      const outage = await syncPendingOutbox();
      const failed = db.prepare("SELECT status, failure_category, next_retry_at FROM sync_outbox WHERE entity_id = ?").get(created.sale.id);
      const beforeDue = await syncPendingOutbox();
      online = true;
      // Advance the test clock to the persisted retry deadline; do not bypass
      // production retry classification or manually reset the queue entry.
      const OriginalDate = Date;
      const due = new OriginalDate(failed.next_retry_at).getTime() + 1000;
      globalThis.Date = class extends OriginalDate { constructor(...args) { super(...(args.length ? args : [due])); } static now() { return due; } };
      const recovered = await syncPendingOutbox();
      const repeated = await syncPendingOutbox();
      const stock = db.prepare("SELECT quantity FROM drugs WHERE id = 'drug-test'").get().quantity;
      const count = db.prepare('SELECT count(*) AS count FROM sales').get().count;
      const queue = db.prepare("SELECT status, attempts FROM sync_outbox WHERE entity_id = ?").get(created.sale.id);
      const receipt = db.prepare('SELECT sync_status, remote_sale_id FROM sales WHERE id = ?').get(created.sale.id);
      closeDatabase();
      console.log(JSON.stringify({outage,failed,beforeDue,recovered,repeated,stock,count,queue,receipt,received,localId:created.sale.id}));
    `
    try {
      const output = execFileSync(process.execPath, ['--input-type=module', '--eval', script], {
        cwd: path.resolve('local-branch-server'), encoding:'utf8',
        env: {...process.env, HEALTHFLOW_DB_PATH:path.join(directory,'branch.sqlite'), ORGANIZATION_ID:'org-test', BRANCH_ID:'branch-test', SUPABASE_URL:'https://example.invalid', SUPABASE_SYNC_KEY:'test-key', BRANCH_SYNC_TOKEN:'test-token'},
      })
      const result = JSON.parse(output.trim().split(/\r?\n/).at(-1))
      expect(result.outage).toMatchObject({failed:1,synced:0})
      expect(result.failed).toMatchObject({status:'failed',failure_category:'TRANSIENT'})
      expect(result.beforeDue.total).toBe(0)
      expect(result.recovered).toMatchObject({failed:0,synced:1})
      expect(result.repeated.total).toBe(0)
      expect(result.received).toEqual([result.localId])
      expect(result.stock).toBe(8)
      expect(result.count).toBe(1)
      expect(result.queue).toEqual({status:'synced',attempts:2})
      expect(result.receipt).toEqual({sync_status:'synced',remote_sale_id:'cloud-sale'})
    } finally {
      fs.rmSync(directory,{recursive:true,force:true})
    }
  })
})
