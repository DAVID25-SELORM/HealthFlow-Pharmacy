# Critical Logic Register

| Area | Primary implementation | Database/functions | Failure behavior | Owner | Known protection |
|---|---|---|---|---|---|
| Authentication | `src/context/AuthContext.jsx`, `src/lib/supabase.js` | Supabase Auth, `staff-admin` | Access blocked; controlled recovery error | Product owner | Auth characterization tests, hash gate |
| Tenant security | Tenant/Auth contexts, `tierAccessService` | RLS, `tier-access` | Cross-tenant access denied | Product owner | Tier/tenant tests, CODEOWNERS |
| NHIS readiness/scrub | `src/services/nhisService.js`, `src/pages/Nhis.jsx` | NHIS RPCs and catalogs | Errors block; warnings require current override flow | Product owner | 180+ focused tests, hash/golden gate |
| CLAIM-it export | `src/services/nhisService.js` | Storage signed URLs | Export fails closed on missing required data/files | Product owner | CXF contract and attachment tests |
| Pricing/inventory | Pricing, drug, inventory services | Stock/pricing RPCs | Invalid writes blocked | Product owner | Pricing/inventory tests |
| Recycle Bin | `recycleBinService`, `RecycleBin` page | recycle/restore/permanent-delete RPCs | Unauthorized action blocked; list errors retryable | Product owner | Service tests, hash gate |
| Offline | Installer release and Offline Sync services/pages | Release tables/storage/RLS, branch server | Unauthorized/unvalidated downloads blocked | Product owner | Installer/sync tests, hash gate |
| Audit | `auditService`, Activity Log | audit RPC/table | Business work follows documented non-blocking policy | Product owner | Audit tests |

Detailed rules are in `production-business-rules.md`. Remaining gap: hosted RLS and deployed-function parity cannot be proven from repository files alone; deployment verification must record the live project state without storing credentials.
