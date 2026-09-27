# Contributing

Thanks for looking at this. Issues and pull requests are welcome.

## Before you start

```bash
node tools/smoke.mjs                      # offline smoke suite, 47 assertions, no DSH needed
node tools/verify-install.mjs --package   # packaging self-check, no DSH needed
```

Both must exit `0`. The smoke suite is the contract: if you change behaviour, either make the
suite agree with the new behaviour deliberately, or the suite will tell you what you broke.

## Ground rules

1. **No build step, and keep it that way.** `lib/client.js` is a hand-written bundle in the official
   `window.__ModuleLoader__.load({ id, factory })` format. Do not introduce a bundler, a transpiler,
   or a dependency — the plugin deliberately ships zero runtime dependencies.
2. **Never add a `title` attribute to the HUD.** A native browser tooltip appears as an opaque black
   box about a second after hover and covers the panel. Put the summary in `aria-label` instead. The
   smoke suite asserts this.
3. **Keep one copy of every formula.** Apportionment and cost arithmetic live in the render path
   only. A previous version also exposed an injected helper that duplicated the apportionment maths;
   the two drifted, and it was deleted. If you need a value in two places, extract a function and
   call it from both.
4. **Write comments that explain *why*, not *what*.** The non-obvious parts of this plugin are all
   "we tried the obvious thing and it was wrong"; record that, or the next person will re-try it.
5. **Line endings are LF** and are enforced by `.gitattributes`. Don't fight it.

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
