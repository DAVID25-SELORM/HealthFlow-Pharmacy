// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('allows NHIS staff uploads and replacement while retaining tenant and role isolation', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create role authenticated;
      create schema auth;
      create schema storage;
      create function auth.uid() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000001'::uuid $$;
      create function public.user_organization_id() returns uuid language sql as $$ select '00000000-0000-0000-0000-000000000010'::uuid $$;
      create function storage.foldername(text) returns text[] language sql as $$ select string_to_array($1, '/') $$;
      create table public.users (id uuid, role text, assigned_roles text[], can_manage_claims boolean);
      insert into public.users values (auth.uid(), 'assistant', '{}', true);
      create table public.nhis_claims (organization_id uuid);
      create table storage.buckets (id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]);
      create table storage.objects (bucket_id text, name text, marker text);
      alter table storage.objects enable row level security;
      grant usage on schema public, auth, storage to authenticated;
      grant select on public.users to authenticated;
      grant select, insert, update, delete on storage.objects to authenticated;
    `)
    await db.exec(readFileSync('supabase/migrations/20260610180000_add_nhis_prescription_attachments.sql', 'utf8'))
    const insert = "insert into storage.objects values ('nhis-prescriptions', '00000000-0000-0000-0000-000000000010/2026-09/claim/rx.pdf', 'original')"
    await db.exec('set role authenticated')
    await expect(db.exec(insert)).rejects.toThrow(/row-level security/)
    await db.exec('reset role')
    const migration = readFileSync('supabase/migrations/20260929210000_fix_nhis_prescription_upload_access.sql', 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    for (const [role, assigned, delegated] of [
      ['assistant', [], true], ['assistant', [], false], ['records_officer', [], false],
      ['cashier', ['claims_officer'], false], ['cashier', [], true], ['admin', [], false],
      ['branch_manager', [], false],
    ]) {
      await db.query('update public.users set role=$1, assigned_roles=$2, can_manage_claims=$3', [role, assigned, delegated])
      await db.exec('truncate storage.objects; set role authenticated')
      await db.exec(insert)
      await db.exec("update storage.objects set marker='replaced'")
      expect((await db.query('select marker from storage.objects')).rows).toEqual([{ marker: 'replaced' }])
      await expect(db.exec(insert.replace('000000000010/', '000000000099/'))).rejects.toThrow(/row-level security/)
      await expect(db.exec(insert.replace('nhis-prescriptions', 'other-bucket'))).rejects.toThrow(/row-level security/)
      await expect(db.exec("update storage.objects set name='00000000-0000-0000-0000-000000000099/rx.pdf'")).rejects.toThrow(/row-level security/)
      await db.exec('reset role')
    }
    await db.exec("update public.users set role='cashier', assigned_roles='{}', can_manage_claims=false; set role authenticated")
    await expect(db.exec(insert)).rejects.toThrow(/row-level security/)
    await expect(db.exec("update storage.objects set marker='unauthorized'")).rejects.toThrow(/row-level security/)
  } finally {
    await db.close()
  }
}, 30000)
