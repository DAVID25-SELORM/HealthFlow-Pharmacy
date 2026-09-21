// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('patches only accreditation INSERT columns and preserves omitted generated dates on replay', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create table nhia_configuration (
        credential_code text primary key, accreditation_expiry_date date
      );
      create function branch_sync_upsert_nhia_configuration(p_sync_token text, p_config jsonb)
      returns jsonb language plpgsql as $body$
      begin
        insert into nhia_configuration (
          accreditation_expiry_date,
          credential_code
        ) values (
          nullif(p_config->>'accreditation_expiry_date', '')::date,
          p_config->>'credential_code'
        ) on conflict (credential_code) do update set
          accreditation_expiry_date = excluded.accreditation_expiry_date,
          credential_code = excluded.credential_code;
        return p_config;
      end;
      $body$;
    `)
    const sql = readFileSync('supabase/migrations/20260811173000_preserve_nhia_accreditation_generated_date.sql', 'utf8')
    await db.exec(sql)
    await db.exec(sql)
    await db.query('select branch_sync_upsert_nhia_configuration($1,$2::jsonb)', ['', JSON.stringify({
      credential_code: 'SYNTHETIC-TEST', accreditation_expiry_date: '2027-01-01', accreditationDateGenerated: '2026-01-01',
    })])
    await db.query('select branch_sync_upsert_nhia_configuration($1,$2::jsonb)', ['', JSON.stringify({
      credential_code: 'SYNTHETIC-TEST', accreditation_expiry_date: '2028-01-01',
    })])
    const result = await db.query('select accreditation_date_generated::text as generated, accreditation_expiry_date::text as expiry from nhia_configuration')
    expect(result.rows).toEqual([{ generated: '2026-01-01', expiry: '2028-01-01' }])
  } finally { await db.close() }
}, 60000)
