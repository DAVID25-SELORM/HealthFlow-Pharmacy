# HealthFlow Production Business Rules

Version: 2026-08 baseline. These IDs are stable and must be cited by changes that affect the rule.

| ID | Rule | Enforcement | Outcome | Evidence |
|---|---|---|---|---|
| AUTH-001 | A signed-in user must resolve to an active application identity before protected work is available. | `AuthContext`, Auth/role services | Block | `AuthContext.test.jsx` |
| AUTH-002 | Recovery links must work across browsers/devices and invalid or reused tokens fail safely. | `AuthContext`, Supabase recovery flow | Block | Recovery tests in `AuthContext.test.jsx` |
| TENANT-001 | Data access remains scoped to the active organization and branch; selected roles must be assigned to the user. | RLS, `tier-access`, contexts | Block | `tier-access/index.test.js`, tenant tests |
| STAFF-001 | Admin-created staff credentials are preserved exactly; status, role, organization, and branch remain enforced. | `staff-admin`, settings service | Block | `settingsService.staff.test.js` |
| NHIS-001 | CCC/CC code must satisfy current readiness rules before serving/final submission. | `nhisService` | Block | NHIS readiness tests |
| NHIS-002 | Ghana Card-linked CLAIM-it exports use the saved numeric HIN as member number and a blank card serial; ordinary members retain their numeric NHIS number. | `nhisService` | Block | NHIS tests and golden contract |
| NHIS-003 | Pharmacy prescription attachments and verification follow current intake/final-export rules; hospital attachment behavior remains optional unless explicitly required. | `nhisService` | Block/warn by workflow | NHIS attachment tests |
| NHIS-004 | Export date filters use service date, with the documented creation-date fallback only when service date is absent. | `nhisService` | Block invalid periods | NHIS export-period tests |
| SCRUB-001 | Duplicate claims are detected before export and one claim can be retained while the duplicate is removed through authorized workflow. | NHIS scrub/export | Block | Duplicate export tests |
| SCRUB-002 | Required member, prescriber, diagnosis, medicine, tariff/G-DRG, attachment, and other issue categories preserve their current severity. | NHIS readiness/scrubber | Block/warn/info | `nhisService.test.js` |
| SCRUB-003 | Active-medication checks exclude the current claim, normalize dose frequency, support Ghana calendar-day partial dispensing, and block remaining full-course coverage. | DB RPCs and NHIS service | Block/warn | Active-medication tests/migrations |
| PRICE-001 | Claim totals, drug prices, tariff prices, and service-line totals use their existing authoritative calculations. | NHIS/pricing services | Block invalid values | Pricing and NHIS tests |
| INVENTORY-001 | Direct serving and normal dispensing preserve transactional stock behavior and permissions. | NHIS/inventory services and RPCs | Block | Serving/inventory tests |
| EXPORT-001 | CXF generation remains parseable, attachment-complete, bounded for large batches, and cannot silently omit requested files. | `nhisService` | Block | CXF and attachment tests |
| RECYCLE-001 | Authorized deletion is recoverable, tenant-scoped, and auditable; permanent deletion requires explicit authorization. | Recycle Bin RPC/service | Block | `recycleBinService.test.js` |
| OFFLINE-001 | Offline installer publication, download permission, signed access, branch registration, and sync remain separately authorized. | Installer release service, branch server | Block | Offline installer/sync tests |
| AUDIT-001 | Security and critical claim actions retain actor, organization, action, and result evidence without exposing secrets or clinical payloads in logs. | Audit service and RPCs | Non-blocking where documented | `auditService.test.js` |

## Change Rule

Do not infer new business behavior from this register. If production behavior is unclear, document the gap and obtain product-owner approval before changing it. Updating a rule requires tests that show the old and approved new behavior, migration impact where applicable, rollback steps, and CODEOWNER approval.
