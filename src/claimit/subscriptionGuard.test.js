// @vitest-environment node
import { readFileSync } from 'node:fs'
import { PGlite } from '@electric-sql/pglite'
import { expect, it } from 'vitest'

it('allows trusted service updates but blocks tenant subscription escalation', async () => {
  const db = new PGlite()
  try {
    await db.exec(`
      create schema auth;
      create function auth.uid() returns uuid language sql as $$ select nullif(current_setting('test.uid', true), '')::uuid $$;
      create function auth.role() returns text language sql as $$ select nullif(current_setting('test.role', true), '') $$;
      create table users (id uuid, role text, is_active boolean);
      create table organizations (
        name text, billing_status text, plan_code text, subscription_tier text,
        trial_ends_at timestamptz, subscription_ends_at timestamptz, manual_grace_until timestamptz,
        subscription_grace_days integer, subscription_restricted_at timestamptz,
        subscription_suspended_at timestamptz, last_payment_at timestamptz,
        next_payment_due_at timestamptz, billing_notes text
      );
      insert into organizations (name, subscription_tier) values ('Test facility', 'basic');
      insert into users values ('00000000-0000-0000-0000-000000000001', 'admin', true);
    `)
    const original = readFileSync('supabase/migrations/20260918090000_subscription_lifecycle_and_role_access.sql', 'utf8')
      .match(/create or replace function public.guard_subscription_metadata\(\)[\s\S]*?end \$\$;/)[0]
    await db.exec(original)
    await db.exec('create trigger guard_subscription_metadata before update on organizations for each row execute function guard_subscription_metadata()')
    await db.exec("set test.role='service_role'")
    await expect(db.exec("update organizations set subscription_tier='pro'")).rejects.toThrow(/Only platform administrators/)
    const migration = readFileSync('supabase/migrations/20260929220000_allow_service_subscription_updates.sql', 'utf8')
    await db.exec(migration)
    await db.exec(migration)
    await db.exec("update organizations set subscription_tier='pro'")
    expect((await db.query('select subscription_tier from organizations')).rows[0].subscription_tier).toBe('pro')
    await db.exec("set test.role='authenticated'; set test.uid='00000000-0000-0000-0000-000000000001'")
    for (const change of [
      "subscription_tier='enterprise'", "plan_code='premium'", "billing_status='active'",
      "trial_ends_at=now()", "subscription_ends_at=now()", "manual_grace_until=now()",
      'subscription_grace_days=365', 'subscription_restricted_at=now()',
      'subscription_suspended_at=now()', 'last_payment_at=now()', 'next_payment_due_at=now()',
      "billing_notes='paid'",
    ]) {
      await expect(db.exec(`update organizations set ${change}`)).rejects.toThrow(/Only platform administrators/)
    }
    await db.exec("update organizations set name='Renamed facility'")
    await db.exec("update users set role='super_admin'")
    await db.exec("update organizations set subscription_tier='enterprise'")
    await db.exec('update users set is_active=false')
    await expect(db.exec("update organizations set subscription_tier='basic'")).rejects.toThrow(/Only platform administrators/)
    await db.exec("reset test.uid; set test.role='anon'")
    await expect(db.exec("update organizations set subscription_tier='basic'")).rejects.toThrow(/Only platform administrators/)
    await db.exec('reset test.role')
    await expect(db.exec("update organizations set subscription_tier='basic'")).rejects.toThrow(/Only platform administrators/)
  } finally {
    await db.close()
  }
}, 30000)
