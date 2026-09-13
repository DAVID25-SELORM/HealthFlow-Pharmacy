# NHIS integrity audit ? stop-condition findings

Status: NO-GO for applying the pending duration migration or claiming a complete authoritative integrity contract. This is an initial source audit, not a completed certification. The requested stop conditions were reached: state requirements conflict and the pending migration can obstruct incremental historical corrections. No application code changed, no migrations applied, no commit/push/deployment.

## Actual states and unresolved policy
The status constraint in 20260618150500_allow_nhis_serving_workflow_statuses.sql permits draft, pending, pending_serving, serving_in_progress, returned_for_review, served, partially_served, fully_served, submitted, approved, accepted, rejected, paid, failed. claim_ready is recognized by frontend helpers and newer guards but absent from that constraint. This is a repository inconsistency; live schema must be checked before declaring it usable. Scrubbed/export-ready/exported are not established here as persisted status values. Serving status and claim status are separate dimensions.

getNhisIntakeSaveStatus maps save_details to draft and new/initial dispatch to pending_serving. canSaveNhisIncompleteIntake explicitly permits incomplete new intake and edits of draft/pending_serving/serving_in_progress, plus blocked corrections of served/claim_ready/returned_for_review. canCorrectNhisClaimStatus disallows submitted/paid/approved/accepted. updateNhisClaimStatus accepts served/submitted/paid/rejected without a source-state transition table. No complete canonical transition graph exists in these inspected paths.

Question requiring a business decision: which existing export-only blockers must block actual serving? The current readiness validator intentionally makes dose/frequency warnings at serving and blockers at correction/final submission; pharmacy attachments are mandatory at final export and some served saves, while incomplete-intake overrides exist. Hospital diagnosis rules differ from pharmacy rules. It would invent business rules to require every final-export field at every non-Draft write.

## Findings by severity
CRITICAL (transaction ordering): updateNhisClaimStatus('paid') calls recordNhisPaidLedgerEntry, which inserts nhis_claim_payments, BEFORE the separate claim-status update. A subsequent CCC/duration/status/permission failure can leave the payment inserted. These are distinct requests, not one atomic transaction. Fix requires an authorized server payment/status transaction with idempotency and existing accounting semantics; merely swapping requests reverses the partial-write risk.

HIGH (legacy correction compatibility): 20260913160000_enforce_nhis_duration_integrity.sql validates every non-Draft claim update and every medicine insert/update against ALL medicines. An unrelated attachment/header correction or one-at-a-time duration repair is rejected while another historical duration remains invalid. Combined CCC enforcement can also prevent duration repair from bumping parent updated_at when CCC is missing. Must establish a controlled, auditable correction transaction capable of repairing combined failures, or a precisely defined non-progression repair exception. Do not apply this migration as blanket certification.

HIGH (incomplete override remains broad): createNhisClaim and updateNhisClaim permit readiness.blockers when allowIncompleteReview/reviewOnly is true. CCC/duration have independent guards, but the broader rule set is still bypassable in these services. Whether each blocker belongs at serving versus export is not uniform and requires the state contract.

HIGH (status-only progression): updateNhisClaimStatus does not load and validate full clinical readiness before served/submitted/paid. Table guards cover selected rules, not the entire readiness assessment.

HIGH (branch assurance unresolved): inspected serve RPCs derive organization and actor permissions but do not visibly check branch membership in their own bodies. SECURITY DEFINER operations must be assessed with their complete authorization helpers and live grants; organization checks alone do not prove branch isolation. No exploitation attempted.

HIGH (membership contract conflict): resolveClaimItMemberIdentifiers accepts an explicit alphabetic cardSerialNo. The request requires it blank for both ordinary NHIS and Ghana Card-linked claims. Numeric Ghana-linked HIN mapping is present, but a numeric pattern alone does not establish verified provenance versus portal patient number. Full verification-chain audit remains required.

MEDIUM (validator duplication): React entry validation, shared CCC/duration validators, service readiness flags, SQL CCC/duration triggers, offline saves, and export analyzers have differing scopes. Readiness returns free-text blockers; CCC/duration throw separately, so blockers are not collected by one authoritative structured contract.

MEDIUM (state vocabulary): claim_ready is referenced without inclusion in the inspected status constraint. This requires live contract verification, not adding a guessed state.

## Rule inventory from inspected sources
| Rule | Established requirement / caveat | Source |
|---|---|---|
| Patient | surname, folder; patient_id link is nullable, not universally mandatory | assessNhisClaimReadiness; save payload |
| Membership | format validation; numeric HIN for Ghana Card at final export | readiness; resolveClaimItMemberIdentifiers |
| CCC | saved protected states and served lines; export checks | shared CCC module; CCC migration; export |
| Diagnosis | required for hospital; maximum count; diagnosis-treatment checks contextual | readiness |
| Dates | service date required; service payload can default to today; clinical overlap must retain established date precedence | service mapping; cross-facility migration |
| Prescriber/facility | facility required; prescriber validation conditional | readiness |
| Attachment | pharmacy final-export attachment and verification; not universal hospital rule | readiness; intake helper |
| Medicine | catalogue selection, active facility-eligible item, description, pricing unit | readiness |
| Strength/dose | structured entry rules; no evidence here of universal separate strength NOT NULL requirement | medicine entry and dose utilities |
| Frequency | correction/final requirement; serving warning in existing readiness | requireMedicineDirections |
| Duration | strict clinical syntax; Draft exception; final normalization without clinical rewrite | duration modules/migration |
| Quantities | prescribed >0, served quantity/status consistency, unserved reason | readiness and medicine mapper |
| Price/total | mapper uses unit price times served quantity; database catalogue/total guards exist and need complete interaction tests | medicine mapper; pricing migrations |
| Hospital tariff | tariff item/code/description, quantity, provider class, set and price/total comparison | readiness |
| Overlap | existing calendar-day precedence is binding; no new date fallback authorized | cross-facility contract |
| Duplicate | application store check exists; concurrent SQL enforcement not established by this pass | assertNoDuplicateNhisClaimInStore |
| Tenant/branch | must derive identity and apply scope in authoritative transactions | RLS and RPC review outstanding |
| Final export | readiness + duration review; all-or-nothing gate; serializer alone is not the authorization boundary | checkNhisExportReadiness/exportNhisClaimsFile |

## Rule ? path ? state coverage
| Path family | Observed validation | Gap / unresolved state scope |
|---|---|---|
| New/draft/review-only create | service readiness + CCC/duration; separate parent/children writes | broad override; non-atomic creation |
| Claim/medicine edit, diagnosis/prescriber/facility change | update service + privileged RPC variant | full replacement, broad override, legacy correction conflict |
| Medicine add | UI duration/dose/catalogue entry | frontend not authoritative |
| Medicine delete | inventory guard exists | no complete claim-minimum-line transition check established |
| Attachment add/delete | claim patch/full-save paths need individual tracing | any unrelated legacy update can hit broad duration trigger |
| Dispensary | serving RPC + scoped medicine service checks | narrower than final readiness; source-state policy unresolved |
| Direct Serve | actor/org/CCC/positive quantity; duration final-state guard pending | broader clinical checks absent from inspected RPC |
| Status/completion/payment | status whitelist, payment write, claim update | no unified validation; payment atomicity critical |
| Admin/Claims Officer correction | dedicated audited RPC, role helper, medicine replacement | combined legacy defects may block correction |
| Offline create/edit/save/serve | local CCC/duration and pricing helpers | cannot substitute for complete cloud validation |
| Sync/reconnect | JSON snapshot/outbox + cloud replacement RPC | older clients require backend rule parity; complete matrix not executed |
| Import/migration | snapshot import preserves raw history | must preserve readability without permitting invalid progression |
| Scrub/bulk scrub | contextual readiness flags | complete structured blocker collection not consolidated |
| Pre-export/CXF/export | final validation and normalization | must remain last safety net; membership serial conflict |

## Contract proposal (not implemented pending state decision)
Use an explicit transition intent and persisted source/target state; derive organization, branch, actor and reference data server-side. Return stable codes plus scope, field, medicine reference, severity and message. Reuse existing clinical checks rather than inferring codes by parsing English strings. Separate incomplete intake, serving, correction, final export and settlement requirements. Validate and perform stock/financial/status/audit effects in the same authorized transaction. Revalidate old-client and offline writes at that boundary. Read-only legacy retrieval must remain independent of progression validity. A correction transaction must derive before/after snapshots from locked database rows.

## Verification status and next steps
This pass is source inspection only. Previous duration work has tests, but those do not certify this broader matrix. No new test/lint/build result is claimed. No new implementation or migration created; only this report. Required next checks include combined CCC+duration legacy correction, partial historical repair, actual payment rollback, complete RPC role/branch tests, old-client payloads, tariff snapshot behavior, concurrent totals, and the requested full regression suite after the state contract is resolved.

GO/NO-GO: NO-GO. Do not apply integrity migrations or claim all bypasses eliminated. Resolve serving-versus-export requirements and controlled legacy correction behavior first; then implement atomic protected transitions and validate the matrix.
