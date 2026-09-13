# Prescription save and search responsiveness - 13 September 2026

The attachment save path uploaded the original prescription to storage, inserted its required CLAIM-it base64 derivative into the claim, then sent the entire payload again merely to set the generated claim-number filename. The last update also requested the full claim response. The implementation now sends only the three attachment naming/type fields and requests no representation. The CLAIM-it bytes, original prescription, clinical validation, audit writes and save ordering remain intact. Filename update failures are checked rather than ignored.

A form-local upload session reuses an in-flight or successful upload when retrying the same selected File with the same user, organization, claim, month and backend mode. Failed uploads can retry. Changing/clearing the file, opening a different claim or resetting the form clears the cache. Nothing is persisted in browser storage, and uploads still begin only when Save is requested. This avoids repeat upload traffic after a later claim-save failure; it does not make existing multi-step claim creation transactional.

Claims search starts after 250 ms of idle typing (previously 400 ms), retains existing page caching and same-request deduplication, and discards responses/errors from superseded page/filter requests. Old requests can no longer clear the loading indicator for a newer request. Save success feedback appears before the post-save overview refresh, after the required save and audit steps complete.

Validation: 224 NHIS service/upload-session tests passed, including a test that the attachment rename contains no base64, tests for retry reuse and scope changes, and existing CLAIM-it/clinical behavior tests. The 136 contract tests ran; one Windows line-ending-sensitive contract initially failed, then passed after restoring LF line endings (227 tests in the focused rerun). Lint and production build passed. No production timing claim is made: bandwidth, server latency, audit requests and list refresh still contribute to elapsed time. These are targeted improvements to the identified workflow, not evidence that every system screen is faster.

Files: src/pages/Nhis.jsx; src/services/nhisService.js; src/services/nhisService.test.js; src/utils/prescriptionUploadSession.js and its test. The protected NHIS service fingerprint is updated with this report and regression coverage. No database migration, pricing, permissions, stock effects or audit behavior is changed.

The user subsequently authorized review, commit and push of these changes. No deployment was performed by this task. Live before/after measurements on the affected connection remain outstanding.

Final pre-push review: all 360 tests across 38 files passed, together with lint, production build, protected baseline, 118 migration checks and whitespace validation.
