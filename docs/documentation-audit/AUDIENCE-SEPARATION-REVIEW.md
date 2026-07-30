# Audience Separation Review

## Pharmacy-Facing Material

Reviewed:

- `docs/pharmacy_pitch_deck.html`
- Pharmacy sections of the combined HealthFlow decks
- `docs/client-manual/HealthFlow-Client-User-Manual.html`

Result:

- Pharmacy workflow claims are now scoped to dispensing, inventory, POS, configured insurance/NHIS support, reporting, and offline operation where enabled.
- Broad or absolute wording around claim support was narrowed.
- No Platform Admin navigation or internal deployment information appears in the pharmacy pitch deck.

## Hospital-Facing Material

Reviewed:

- `docs/hospital_pitch_deck.html`
- Hospital sections of the combined HealthFlow decks

Result:

- Hospital material now uses configured-service language where full module completion was not independently verified.
- Absolute statements such as eliminating handoff gaps and automatic submission were softened.
- No Platform Admin navigation or internal deployment information appears in the hospital pitch deck.

## Facility User Manuals

Reviewed:

- `docs/client-manual/HealthFlow-Client-User-Manual.html`
- `docs/client-manual/NHIS-MCA-Claims-Officer-User-Manual.md`
- `docs/client-manual/NHIS-MCA-Claims-Officer-User-Manual.html`

Result:

- The NHIS claims-officer manual no longer instructs users to use Super Admin or Tenant Admin controls.
- Technical setup items that remain in the broad client manual are operational support guidance for branch tokens, CLAIM-it local service, and secrets handling, not Platform Admin instructions.

## Insurer and Company Material

No insurer-only or company-only pitch deck/manual files were present in the current `docs/` tree. Any future insurer or company deliverables should undergo the same isolation review before distribution.
