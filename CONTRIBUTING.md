# Contributing

Thanks for looking at this. Issues and pull requests are welcome.

## Before you start

```bash
node tools/smoke.mjs                      # offline smoke suite, 64 assertions, no DSH needed
node tools/verify-install.mjs --package   # packaging self-check, no DSH needed
```

Both must exit `0`. The smoke suite is the contract: if you change behaviour, either make the
suite agree with the new behaviour deliberately, or the suite will tell you what you broke.

CI (`.github/workflows/ci.yml`) runs exactly those two scripts on **ubuntu, windows and macos** with
Node 20. Both are fully offline — no DSH install, no network, no build step — so the matrix runs in
clean containers and proves that line endings (`.gitattributes` pins LF), path derivation and
`import.meta` usage do not depend on Windows. A green run on all three is the bar for a pull request.

## Ground rules

1. **No build step, and keep it that way.** `lib/client.js` is a hand-written bundle in the official
   `window.__ModuleLoader__.load({ id, factory })` format. Do not introduce a bundler, a transpiler,
   or a dependency — the plugin deliberately ships zero runtime dependencies.
2. **Never add a `title` attribute to the HUD.** A native browser tooltip appears as an opaque black
   box about a second after hover and covers the panel. Put the summary in `aria-label` instead. The
   smoke suite asserts this.
3. **Separate spending from external balance changes — in both directions.** The token estimate is the
   only authority for that judgement. Money can enter the balance from outside (top-up, bonus grant) and
   it can leave from outside (bonus expiry being reclaimed, refund reversal, billing correction); neither
   is spending. Never classify a raw balance delta as spending without the token bound in
   `classifyRead`. A bare `delta < 0 → spend` rule is exactly the bug that recorded a reclaimed ¥5 bonus
   as ¥5 of session spending — permanently, because the counter only grows.
4. **Persistence must be lossless.** Any field added to a per-session record has to survive the
   `readStore` → modify → `writeStore` round trip. `createTracker` must not map a subset of fields (it
   spreads the persisted record and only fills defaults); `persistTracker` must merge into the record
   already on disk and only overwrite a field the caller actually holds, so it never writes an
   `undefined` value that `JSON.stringify` would silently delete; and neither may any other writer. A
   field dropped here is silently replaced by a fallback on the next read: when `lastRead` was lost this
   way, `previousBalanceOf` fell back to an event balance and swallowed real spending. Both writers are
   lossless today and the smoke suite pins that; keep it that way.
5. **Keep one copy of every formula.** Apportionment and cost arithmetic live in the render path
   only. A previous version also exposed an injected helper that duplicated the apportionment maths;
   the two drifted, and it was deleted. If you need a value in two places, extract a function and
   call it from both.
6. **Write comments that explain *why*, not *what*.** The non-obvious parts of this plugin are all
   "we tried the obvious thing and it was wrong"; record that, or the next person will re-try it.
7. **Line endings are LF** and are enforced by `.gitattributes`. Don't fight it.
8. **Never trust persisted user config — validate it field by field at load.** Anything the user can
   edit (currently the `dsh-balance-hud:settings:v1` blob behind the *Settings → General* row) is
   untrusted input: a hand-edited value, a field left over from an older version, or corrupt JSON must
   all fall back to a default rather than reaching the UI or the price table. `normalizeSettings` is
   the boundary that does this — whitelist every field and re-validate on every read — and
   `loadSettings` wraps the parse so bad JSON never throws. Add a new setting by adding both its
   whitelist entry and its default, never by reading the raw object.
9. **Any new slot registration must be reflected in the smoke suite's registration assertion.** The
   suite currently expects **exactly two** registrations — `shell.overlay` (`balance-hud`) and
   `settings.general.item` (`balance-hud-settings`) — asserts the overlay's slot `name` and `id`, and
   asserts that the settings row is registered. That assertion exists so a registration which silently
   stops firing (a broken `ctx.slots.inject`, a renamed slot) cannot pass unnoticed, and so nothing
   takes over a whole settings page by accident. When you legitimately add a third registration, update
   the count in the same commit.
10. **Any new outbound network destination must be opt-in, named, and documented in both READMEs.**
    The plugin's default state sends nothing to a third party, and that is the whole substance of the
    privacy section. Today there is exactly one exception: the opt-in price sync to
    `https://api-docs.deepseek.com/zh-cn/quick_start/pricing`. A new destination must
    (a) stay **off** until the user deliberately enables it — a button press or an explicit interval
    choice, never an install-time default; (b) be stated **with its exact host** in the privacy section
    of *both* `README.md` and `README.zh-CN.md`, together with what is not sent; and (c) be fetched by
    the **Host half** through a loopback-only route — never by the browser, and never with a query
    parameter that identifies the user. "Off by default" is part of the contract, not a nicety: a HUD
    that silently starts talking to a new host is a privacy regression even if the payload is harmless.
11. **Anything that feeds a money calculation must validate semantically, not merely parse, and must
    fall back to the last good data.** A parse that returns plausible numbers in the wrong slots is
    worse than no parse at all, because nothing in the UI can tell the difference. The price-table
    parser is the worked example: it checks the official relation (`peak > off`, strictly) for every
    model and category, and when the check fails it rejects the sync **wholesale** and keeps the
    built-in or previously synced table. Do not salvage a partial result, do not treat a parse failure
    as "the price is 0", and do not make a judgement from a human-readable label — the fetch path can
    hand back UTF-8 bytes decoded as Latin-1, which turns every Chinese label on the page into
    mojibake. See §7 of `docs/DESIGN.md` (and §7 of `docs/DESIGN.zh-CN.md`).

## Testing notes

The suite evaluates the real `lib/client.js` against a fake React runtime, fake host responses,
a fake `localStorage` and a fake `document`. Two things worth knowing:

- **The React shim must respect `useRef(initialValue)`.** It once didn't, and the mismatch only
  surfaced months later when a component started depending on the initial value.
- **Intermediate UI states need a hanging request to be observable.** If a mock resolves
  immediately, states like `querying…` are collapsed into the same microtask batch and cannot be
  asserted. Use `bonusMode = 'hang'`. That is the test being too fast, not the feature being absent.

State that cannot be reached through the component is exported on `exports.__test` and asserted
directly as a pure function. Prefer that over contriving a render.

## Changing the Host half

`lib/index.js` is **not** loaded by the smoke suite, and profile bundles are not hot-loaded:

- client half (`lib/client.js`) → a page refresh is enough
- Host half (`lib/index.js`), or adding/removing a route → **restart DSH**

If you touch the Host half, verify it by hand and say so in the pull request.

## Commit messages

Conventional-commit style prefixes (`feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`) are
appreciated but not enforced. One logical change per commit.

## Reporting a wrong number

If a displayed figure is wrong, please include:

- the value shown, the value you expected, and where you expected it to come from
- whether the session was **parallel** (were other sessions running?) — apportioned figures are
  estimates by design
- the relevant rows from the expanded panel (`Session share`, `Other sessions`, `Tracked sessions`),
  which are there precisely so a mis-weighting can be diagnosed without a debugger
- the browser console, if the plugin threw

## License

By contributing you agree that your contribution is licensed under the MIT license in
[LICENSE](LICENSE).
