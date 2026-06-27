# Legacy Supabase SQL

These scripts are retained for operational history and older manual deployment
workflows. They are not the canonical migration chain.

For new database changes, add an ordered migration under `supabase/migrations/`.
Do not rerun a legacy script against production unless its current schema impact
has been reviewed and the operation has been explicitly approved.

The production security audits remain at the repository root because operators
run them directly in the Supabase SQL Editor.
