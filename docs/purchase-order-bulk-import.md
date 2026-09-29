# Purchase order bulk import

## What it does
The "New Purchase Order" modal gets a `Manual Entry | Import Excel/CSV` toggle next
to the existing item-entry panel. Manual entry is untouched. Import lets a user
upload a `.xlsx`/`.csv` file, preview parsed rows with per-row status, resolve
unmatched product names against inventory, optionally combine identical duplicate
rows, and add only the rows they confirm into the current purchase draft's
`lineItems` — the exact same array manual entry writes to.

## Stock safety
Import never calls the database. It only ever produces items for the caller to
push into React state (`setLineItems`). `createPurchase` always saves
`status: 'draft'`; stock only changes later, in `completePurchase` (the
`complete_purchase` RPC), which this feature has no path to. Pinned by
`src/pages/purchaseOrderImport.test.js`.

## Deliberate deviation from a literal product-matching gate
Manual entry already lets a hand-typed drug name through with no match (a new
batch of a catalogued drug, or genuinely new drug, is normal on a purchase order;
`drugId` stays `null` unless a drug was clicked in the search dropdown). Rather
than invent a stricter rule for import alone, an unmatched name is a **warning**
(still importable, with a "Match Item" action to fix a typo), not a blocker — the
same standard manual entry already holds itself to. Several existing drug rows
sharing an exact name (each batch is its own row) is normal here too; it does not
require the user to pick a specific batch, `drugId` is only auto-filled when
exactly one row shares the name, otherwise it stays `null` exactly as a typed,
unselected name would.

## Files
- `src/utils/purchaseItemImport.js` — pure parsing/validation/matching/duplicate-
  grouping logic (header mapping with aliases, a small hand-rolled CSV parser,
  row validation reusing `assertRequiredText`/`assertNonNegativeNumber` from
  `utils/validation.js`, product matching, duplicate grouping). Framework-free,
  fully unit tested (35 tests).
- `src/utils/purchaseItemImportFile.js` — browser file I/O: reads `.xlsx` via
  `read-excel-file` (already a dependency, used by the existing Inventory bulk
  import) or `.csv` via the CSV parser above; writes the downloadable template
  via `write-excel-file` (also already a dependency). No new npm package.
- `src/components/purchases/PurchaseItemImportPanel.jsx` — the preview/resolve UI:
  upload, template download, per-row status badges, Match Item, remove row,
  duplicate-combine toggle, "Import N Valid Rows".
- `src/pages/Purchases.jsx` — the mode toggle, `handleImportItems` (appends to
  `lineItems`, fires a best-effort `purchase.items_imported` audit event with
  counts only), resets to Manual Entry when the modal resets.
- `src/pages/Purchases.css` — new `.purchase-import-*` / `.purchase-item-mode-*`
  styles, reusing existing CSS custom properties.

## Template columns
Drug / Item, Brand Name, Generic Name, Unit, Qty, Unit Cost, Discount %, Batch No.,
Expiry Date, Sale on Return — every column maps to an existing purchase-item
field (no barcode/SKU column: the drug model has none).

## Limits
5 MB file size, 1,000 rows per import. Expiry dates only accept a real `Date`
(from an xlsx date cell) or an ISO `yyyy-mm-dd` string — a locale-ambiguous
string like `03/04/2027` is rejected rather than guessed at.

## Not built (out of scope for this change)
Full inline editing of every cell in the preview table. A truly invalid row
(bad quantity/cost/discount/date, or no drug name) is excluded from import with
its exact reason shown; the user fixes the source file and re-uploads, or adds
that one item manually. Only unmatched-product resolution has an interactive
in-preview action ("Match Item"), since that was the one resolution the request
called out explicitly and the one genuinely worth a UI for.

## Tests
71 passing: 35 in `purchaseItemImport.test.js` (headers/CSV parsing/matching/
validation/calculation-parity/duplicate-grouping), 7 in
`purchaseItemImportFile.test.js` (file-type/size handling, a real CSV `File`
through jsdom's `FileReader`, template generation), 10 in
`PurchaseItemImportPanel.test.jsx` (component-level: preview, match, remove,
combine duplicates, partial import, discard), 7 in `purchaseOrderImport.test.js`
(wiring: manual entry intact, no stock-changing RPC reachable from import, audit
event shape, reset-on-close, shared calculators), plus regression: existing
`Purchases.test.jsx`, `Inventory.test.jsx`, `drugImportService.test.js`,
`purchasesService.test.js`, `purchasesApi.test.js` (31 tests) all still pass
unmodified.

## Not done
No migration (frontend-only feature). Not deployed.
