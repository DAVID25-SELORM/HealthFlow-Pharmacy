## Change Summary

Describe the user-visible and technical change.

## Critical Logic Impact

- [ ] Authentication or staff lifecycle
- [ ] Tenant, organization, branch, RLS, or permissions
- [ ] NHIS/CCC/HIN/Ghana Card behavior
- [ ] Claim scrub rules, duplicates, or active medication
- [ ] CLAIM-it/CXF export or attachments
- [ ] Pricing, tariffs, totals, inventory, or dispensing
- [ ] Recycle Bin or audit trail
- [ ] Offline installer, branch server, or synchronization
- [ ] No critical behavior affected

For each checked area, list rule IDs from `docs/production-business-rules.md` and explain why behavior is preserved or intentionally changed.

## Verification

- [ ] Characterization/regression tests added or confirmed
- [ ] Golden outputs reviewed when applicable
- [ ] Tenant isolation/RLS impact reviewed
- [ ] Migration is additive, ordered, and reversible
- [ ] `npm run verify:production-baseline` passes
- [ ] Rollback steps documented

## Authorization

Business-logic changes require explicit product-owner approval. Include the approval reference here, or write `behavior-preserving`.
