# How changes are kept from breaking what already works

Pharmacies use HealthFlow live. A feature or redesign must never quietly break a
screen that was working yesterday. These rules apply to every change, whoever
writes it.

## The working rules

1. **No unseen interface changes.** Every change to what a user sees goes through
   a pull request with a preview link. The product owner looks at it (on a phone
   when the change touches layout) and says "merge". If "merge" could refer to
   more than one change, ask which one before merging.
2. **Small, scoped changes.** A change touches only what was asked for. Before a
   pull request is opened, read the list of changed files and name anything that
   is not obviously part of the request. Move unrelated edits to their own pull
   request.
3. **Look before and after on the key screens.** Before calling a change ready,
   open the top bar, the notification bell, Sales, NHIS claims, Purchases,
   Inventory, Settings and the menu at phone, tablet and computer widths, as an
   admin and as a restricted user. The browser guard below does the measuring;
   a person still looks at anything visual that changed.

## The automated browser guard

`npm run test:e2e` opens the real built app in a real browser at four sizes
(small phone 360px, phone 390px, tablet 820px, computer 1366px), signed in as an
admin and as a cashier, against a fake backend in `e2e/support/fakeBackend.js`.
It never contacts production.

For every key screen it fails when:

- the page scrolls sideways, or a button or field sits partly off the screen;
- the right menu is missing (bottom bar on phones, side menu on computers);
- the bottom bar can cover the end of a page;
- the page crashes or shows "Unable to load workspace";

and it checks that the notification panel, the phone **More** menu and the
tablet side menu open fully inside the screen.

It runs in CI as the `browser-layout-guard` job on every pull request.

### Running it locally

```powershell
npm run test:e2e
```

If your machine already has a Chromium but not the one this Playwright version
expects, point `PW_CHROMIUM_PATH` at its `chrome.exe` instead of downloading one.
After a failure, open `playwright-report/` or the screenshots in `test-results/`.

### Adding a screen or a check

- New key screen: add it to `SCREENS` in `e2e/keyScreens.spec.js`.
- New fake data a screen needs: add rows to `TABLE_ROWS` in
  `e2e/support/fakeBackend.js`. Unknown tables return an empty list.
- New kind of check: add a function to `e2e/support/layoutChecks.js` that returns
  a list of plain-language problems.

When a real defect is found by a person, add a check that would have caught it
before fixing it. That is how this guard grows.

## Large redesigns

A redesign as large as the navigation rebuild should ship behind an on/off setting
so it can be switched off for a pharmacy without a new release. This is not built
yet; propose it per redesign.
