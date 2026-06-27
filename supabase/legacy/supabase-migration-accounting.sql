-- ================================================
-- ACCOUNTING MODULE MIGRATION
-- ================================================
-- Date: April 16, 2026
-- Description: Phase 1 accounting tables — expenses, cashbook, claim payments
-- Author: David Gabion Selorm
-- ================================================

-- ================================================
-- 1. EXPENSE CATEGORIES
-- ================================================

CREATE TABLE IF NOT EXISTS public.expense_categories (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  name            VARCHAR(100) NOT NULL,
  code            VARCHAR(20)  NOT NULL,
  is_active       BOOLEAN      NOT NULL DEFAULT true,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expense_cats_org ON public.expense_categories(organization_id);

COMMENT ON TABLE public.expense_categories IS 'Admin-defined expense buckets (rent, utilities, salaries, etc.)';

-- ================================================
-- 2. EXPENSES
-- ================================================

CREATE TABLE IF NOT EXISTS public.expenses (
  id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id  UUID        NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id        UUID        REFERENCES public.branches(id) ON DELETE SET NULL,
  category_id      UUID        REFERENCES public.expense_categories(id) ON DELETE SET NULL,
  expense_date     DATE        NOT NULL DEFAULT CURRENT_DATE,
  description      TEXT        NOT NULL,
  amount           NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  payment_method   VARCHAR(20) NOT NULL DEFAULT 'cash'
                   CHECK (payment_method IN ('cash','momo','bank_transfer','cheque','other')),
  vendor_name      VARCHAR(255),
  reference_number VARCHAR(100),
  receipt_url      TEXT,
  notes            TEXT,
  status           VARCHAR(20) NOT NULL DEFAULT 'posted'
                   CHECK (status IN ('draft','posted','cancelled')),
  created_by       UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  approved_by      UUID        REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at       TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_expenses_org       ON public.expenses(organization_id);
CREATE INDEX IF NOT EXISTS idx_expenses_branch    ON public.expenses(branch_id);
CREATE INDEX IF NOT EXISTS idx_expenses_date      ON public.expenses(expense_date);
CREATE INDEX IF NOT EXISTS idx_expenses_status    ON public.expenses(status);
CREATE INDEX IF NOT EXISTS idx_expenses_category  ON public.expenses(category_id);

COMMENT ON TABLE public.expenses IS 'Non-stock operating expense records per branch';

-- ================================================
-- 3. CASHBOOK SESSIONS
-- ================================================

CREATE TABLE IF NOT EXISTS public.cashbook_sessions (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id UUID         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id       UUID         NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  business_date   DATE         NOT NULL DEFAULT CURRENT_DATE,
  opening_cash    NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (opening_cash >= 0),
  expected_cash   NUMERIC(12,2) NOT NULL DEFAULT 0,
  counted_cash    NUMERIC(12,2),
  cash_variance   NUMERIC(12,2) GENERATED ALWAYS AS (counted_cash - expected_cash) STORED,
  notes           TEXT,
  opened_by       UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_by       UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  closed_at       TIMESTAMP WITH TIME ZONE,
  status          VARCHAR(20)  NOT NULL DEFAULT 'open'
                  CHECK (status IN ('open','closed')),
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE (organization_id, branch_id, business_date)
);

CREATE INDEX IF NOT EXISTS idx_cashbook_sessions_org    ON public.cashbook_sessions(organization_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_sessions_branch ON public.cashbook_sessions(branch_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_sessions_date   ON public.cashbook_sessions(business_date);

COMMENT ON TABLE public.cashbook_sessions IS 'One daily register per branch — opened and closed by staff';

-- ================================================
-- 4. CASHBOOK ENTRIES
-- ================================================

CREATE TABLE IF NOT EXISTS public.cashbook_entries (
  id              UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  session_id      UUID         NOT NULL REFERENCES public.cashbook_sessions(id) ON DELETE CASCADE,
  organization_id UUID         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id       UUID         NOT NULL REFERENCES public.branches(id) ON DELETE CASCADE,
  entry_type      VARCHAR(30)  NOT NULL
                  CHECK (entry_type IN ('sale_cash','expense_cash','deposit','withdrawal','adjustment')),
  source_type     VARCHAR(20)
                  CHECK (source_type IN ('sale','expense','claim_payment','manual')),
  source_id       UUID,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  direction       VARCHAR(5)   NOT NULL CHECK (direction IN ('in','out')),
  description     TEXT,
  created_by      UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at      TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cashbook_entries_session ON public.cashbook_entries(session_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_org     ON public.cashbook_entries(organization_id);
CREATE INDEX IF NOT EXISTS idx_cashbook_entries_branch  ON public.cashbook_entries(branch_id);

COMMENT ON TABLE public.cashbook_entries IS 'Line-level cash movements within a session';

-- ================================================
-- 5. CLAIM PAYMENTS (RECEIVABLES LEDGER)
-- ================================================

CREATE TABLE IF NOT EXISTS public.claim_payments (
  id                 UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  organization_id    UUID         NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  branch_id          UUID         REFERENCES public.branches(id) ON DELETE SET NULL,
  claim_id           UUID         NOT NULL REFERENCES public.claims(id) ON DELETE CASCADE,
  insurer_name       VARCHAR(255) NOT NULL,
  approved_amount    NUMERIC(12,2) NOT NULL CHECK (approved_amount >= 0),
  paid_amount        NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (paid_amount >= 0),
  payment_date       DATE,
  payment_method     VARCHAR(20)  DEFAULT 'bank_transfer'
                     CHECK (payment_method IN ('cash','momo','bank_transfer','cheque','other')),
  payment_reference  VARCHAR(100),
  notes              TEXT,
  created_by         UUID         REFERENCES auth.users(id) ON DELETE SET NULL,
  created_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at         TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_claim_payments_org    ON public.claim_payments(organization_id);
CREATE INDEX IF NOT EXISTS idx_claim_payments_claim  ON public.claim_payments(claim_id);
CREATE INDEX IF NOT EXISTS idx_claim_payments_branch ON public.claim_payments(branch_id);
CREATE INDEX IF NOT EXISTS idx_claim_payments_date   ON public.claim_payments(payment_date);

COMMENT ON TABLE public.claim_payments IS 'Records insurer settlements against approved claims (supports partial payments)';

-- ================================================
-- 6. ENABLE RLS
-- ================================================

ALTER TABLE public.expense_categories ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.expenses            ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_sessions   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.cashbook_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.claim_payments      ENABLE ROW LEVEL SECURITY;

-- ================================================
-- 7. RLS POLICIES — EXPENSE CATEGORIES
-- ================================================

DROP POLICY IF EXISTS expense_cats_select_org    ON public.expense_categories;
DROP POLICY IF EXISTS expense_cats_insert_admin  ON public.expense_categories;
DROP POLICY IF EXISTS expense_cats_update_admin  ON public.expense_categories;
DROP POLICY IF EXISTS expense_cats_select_sa     ON public.expense_categories;
DROP POLICY IF EXISTS expense_cats_insert_sa     ON public.expense_categories;
DROP POLICY IF EXISTS expense_cats_update_sa     ON public.expense_categories;

CREATE POLICY expense_cats_select_org ON public.expense_categories
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY expense_cats_insert_admin ON public.expense_categories
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin'))
);

CREATE POLICY expense_cats_update_admin ON public.expense_categories
FOR UPDATE TO authenticated
USING (organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
WITH CHECK (organization_id = public.user_organization_id());

CREATE POLICY expense_cats_select_sa ON public.expense_categories
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY expense_cats_insert_sa ON public.expense_categories
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY expense_cats_update_sa ON public.expense_categories
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

-- ================================================
-- 8. RLS POLICIES — EXPENSES
-- ================================================

DROP POLICY IF EXISTS expenses_select_org   ON public.expenses;
DROP POLICY IF EXISTS expenses_insert_admin ON public.expenses;
DROP POLICY IF EXISTS expenses_update_admin ON public.expenses;
DROP POLICY IF EXISTS expenses_select_sa    ON public.expenses;
DROP POLICY IF EXISTS expenses_insert_sa    ON public.expenses;
DROP POLICY IF EXISTS expenses_update_sa    ON public.expenses;

CREATE POLICY expenses_select_org ON public.expenses
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY expenses_insert_admin ON public.expenses
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','pharmacist'))
);

CREATE POLICY expenses_update_admin ON public.expenses
FOR UPDATE TO authenticated
USING (organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
WITH CHECK (organization_id = public.user_organization_id());

CREATE POLICY expenses_select_sa ON public.expenses
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY expenses_insert_sa ON public.expenses
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY expenses_update_sa ON public.expenses
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

-- ================================================
-- 9. RLS POLICIES — CASHBOOK SESSIONS
-- ================================================

DROP POLICY IF EXISTS cashbook_sessions_select_org   ON public.cashbook_sessions;
DROP POLICY IF EXISTS cashbook_sessions_insert_admin ON public.cashbook_sessions;
DROP POLICY IF EXISTS cashbook_sessions_update_admin ON public.cashbook_sessions;
DROP POLICY IF EXISTS cashbook_sessions_select_sa    ON public.cashbook_sessions;
DROP POLICY IF EXISTS cashbook_sessions_insert_sa    ON public.cashbook_sessions;
DROP POLICY IF EXISTS cashbook_sessions_update_sa    ON public.cashbook_sessions;

CREATE POLICY cashbook_sessions_select_org ON public.cashbook_sessions
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY cashbook_sessions_insert_admin ON public.cashbook_sessions
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','pharmacist'))
);

CREATE POLICY cashbook_sessions_update_admin ON public.cashbook_sessions
FOR UPDATE TO authenticated
USING (organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','pharmacist')))
WITH CHECK (organization_id = public.user_organization_id());

CREATE POLICY cashbook_sessions_select_sa ON public.cashbook_sessions
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY cashbook_sessions_insert_sa ON public.cashbook_sessions
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY cashbook_sessions_update_sa ON public.cashbook_sessions
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

-- ================================================
-- 10. RLS POLICIES — CASHBOOK ENTRIES
-- ================================================

DROP POLICY IF EXISTS cashbook_entries_select_org   ON public.cashbook_entries;
DROP POLICY IF EXISTS cashbook_entries_insert_admin ON public.cashbook_entries;
DROP POLICY IF EXISTS cashbook_entries_select_sa    ON public.cashbook_entries;
DROP POLICY IF EXISTS cashbook_entries_insert_sa    ON public.cashbook_entries;

CREATE POLICY cashbook_entries_select_org ON public.cashbook_entries
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY cashbook_entries_insert_admin ON public.cashbook_entries
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role IN ('admin','pharmacist'))
);

CREATE POLICY cashbook_entries_select_sa ON public.cashbook_entries
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY cashbook_entries_insert_sa ON public.cashbook_entries
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

-- ================================================
-- 11. RLS POLICIES — CLAIM PAYMENTS
-- ================================================

DROP POLICY IF EXISTS claim_payments_select_org   ON public.claim_payments;
DROP POLICY IF EXISTS claim_payments_insert_admin ON public.claim_payments;
DROP POLICY IF EXISTS claim_payments_update_admin ON public.claim_payments;
DROP POLICY IF EXISTS claim_payments_select_sa    ON public.claim_payments;
DROP POLICY IF EXISTS claim_payments_insert_sa    ON public.claim_payments;
DROP POLICY IF EXISTS claim_payments_update_sa    ON public.claim_payments;

CREATE POLICY claim_payments_select_org ON public.claim_payments
FOR SELECT TO authenticated
USING (organization_id = public.user_organization_id());

CREATE POLICY claim_payments_insert_admin ON public.claim_payments
FOR INSERT TO authenticated
WITH CHECK (
  organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin')
);

CREATE POLICY claim_payments_update_admin ON public.claim_payments
FOR UPDATE TO authenticated
USING (organization_id = public.user_organization_id()
  AND EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'admin'))
WITH CHECK (organization_id = public.user_organization_id());

CREATE POLICY claim_payments_select_sa ON public.claim_payments
FOR SELECT TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY claim_payments_insert_sa ON public.claim_payments
FOR INSERT TO authenticated
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

CREATE POLICY claim_payments_update_sa ON public.claim_payments
FOR UPDATE TO authenticated
USING (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'))
WITH CHECK (EXISTS (SELECT 1 FROM public.users WHERE id = auth.uid() AND role = 'super_admin'));

-- ================================================
-- 12. SEED DEFAULT EXPENSE CATEGORIES
-- ================================================

-- Insert default categories for each existing organization
INSERT INTO public.expense_categories (organization_id, name, code, is_active)
SELECT o.id, cat.name, cat.code, true
FROM public.organizations o
CROSS JOIN (
  VALUES
    ('Rent',          'RENT'),
    ('Utilities',     'UTIL'),
    ('Salaries',      'SAL'),
    ('Transport',     'TRANS'),
    ('Maintenance',   'MAINT'),
    ('Petty Cash',    'PETTY'),
    ('Tax',           'TAX'),
    ('Internet',      'NET'),
    ('Supplies',      'SUPP'),
    ('Other',         'OTHER')
) AS cat(name, code)
WHERE NOT EXISTS (
  SELECT 1 FROM public.expense_categories ec
  WHERE ec.organization_id = o.id AND ec.code = cat.code
);

-- ================================================
-- 13. VERIFY
-- ================================================

SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'public'
  AND table_name IN (
    'expense_categories','expenses',
    'cashbook_sessions','cashbook_entries',
    'claim_payments'
  )
ORDER BY table_name;

SELECT policyname, tablename, cmd
FROM pg_policies
WHERE tablename IN (
  'expense_categories','expenses',
  'cashbook_sessions','cashbook_entries',
  'claim_payments'
)
ORDER BY tablename, policyname;

DO $$
BEGIN
  RAISE NOTICE 'Accounting migration applied successfully.';
END $$;
