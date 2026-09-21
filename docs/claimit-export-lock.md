# Claim-IT CXF export format: LOCKED

The CXF export format is locked. It was taken from the West Point July export generated on
2026-09-21 19:28 UTC by the May-shape + signer release, after which the format was accepted for
import (per the operator's report; the exact Claim-IT response was not captured in this repository).

## What is locked
- Envelope, top-level fields, section list and order, `_meta` keys, `_dbstruct` schema (every table, column,
  order, type), the 76-field claim order (`claimType` at position 24, `serviceOutcome` last),
  `appVersion` including `cpuType: x64`, `servVersion` null, provider/policy/medicine version shape,
  accreditation and credential-usage structure, duration shape, validation sections populated.
- A `VALID` claim always carries a signer: the claim's complete stored signature, else the authenticated
  exporting user and the export time; never mixed; null (warned) only when no identity exists.
- Exact decimal totals, deterministic bytes, `dateGenerated` never derived from effective/expiry.

## How it is enforced
1. `src/claimit/lockedExport.test.js` regenerates a CXF and compares it with `locked-export-contract.json`
   and a SHA-256 structure fingerprint. Deliberately breaking the format (claimType position, cpuType,
   servVersion, signers, validation sections) fails it (verified by mutation).
2. `config/production-baseline.json` fingerprints the exporter and lock files; CI (`npm run protect:baseline`)
   rejects any edit that does not update the manifest and an impact report in the same change.
3. `.github/CODEOWNERS` requires owner review for `src/claimit/` and the exporter.

## Changing the format on purpose
Do all of these together, in one reviewed change: (1) generate a file, import it into Claim-IT and keep the
result; (2) regenerate `locked-export-contract.json` with `node scripts/extract-cxf-contract.mjs <file>`;
(3) update `LOCKED_STRUCTURE_SHA256` in the test; (4) update the manifest hashes; (5) write an impact note.
Never edit the tests or the contract just to make CI pass.
