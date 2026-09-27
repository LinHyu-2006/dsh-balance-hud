**English** | [简体中文](DESIGN.zh-CN.md)

# Design notes: dsh-balance-hud

A contributor's guide to *why* the plugin is built the way it is. Read the
[README](../README.md) first for what it does; this document covers the constraints and the accounting
model you must respect when you modify it. The two files that matter are `lib/index.js` (Host half: two
read-only loopback routes) and `lib/client.js` (browser half: the HUD, pricing, accounting,
persistence); `tools/smoke.mjs` executes the latter offline.

---

## 1. Two halves, and the Cordis constraint that forced it

The plugin is split because the browser half **cannot** reach the account service directly. The natural
implementation would be `ctx.remote.account.getBalance()` inside the client plugin. That is impossible on
the client side, for two independent reasons:

1. **Without declaring it**, the Cordis dependency guard throws:

   ```text
   cannot get property "remote.account" without inject
   ```

2. **Declaring it** — `inject = ["remote"]` on the client half — cannot be satisfied in the browser. The
   fiber never resolves, it just hangs forever, and the plugin never activates at all. A hang is worse
   than an error here: nothing tells you the plugin is dead.

Both behaviours were reproduced against real `@deepseek-ai/cordis` 4.0.4. So the access moved to the Host
half, which *can* inject `deepseekAccount`, and the result is relayed over loopback HTTP (`lib/index.js`):

```text
GET /api/balance-hud/balance   → normalize(ctx.deepseekAccount.getBalance(...))
GET /api/balance-hud/bonuses   → normalizeBonuses(ctx.deepseekAccount.getUnnotifiedBonuses(...))
```

Design rules that follow:

- **The relay is read-only, always**, on a loopback-only route: `isLoopback()` accepts `127.0.0.1`, `::1`,
  IPv4-mapped loopback forms and any `127.*` address; everything else gets `403` with a JSON body.
- **No credentials cross the boundary.** The Host half calls only `getBalance` and `getUnnotifiedBonuses`;
  it never calls `resolveToken` or `getPlatformSession`, so the API key stays inside
  `@deepseek-ai/dsh-deepseek-account-platform`.
- **The bonuses route must not ack.** Calling `ackBonusNotified` would mark grants as shown and interfere
  with DSH's own bonus notifications. Reading without acking keeps the data permanently readable, and the
  client de-duplicates by `orderId` instead.
- **One protocol, two halves.** `normalize()` produces
  `{ kind: 'ready' | 'unavailable' | 'error', currency, rechargeTotal, bonusTotal, total }`, and
  `readBalance()` maps route failures onto the same three states. Handler exceptions are returned as HTTP
  200 with `kind: 'error'`, so the client checks `response.ok` **and** the payload `kind`; never treat the
  status code alone as the verdict.

---

## 2. The balance-accounting model

### 2.1 The quantities

Each session's record is `{ baseline, lastBalance, spent, ts }`:

- `baseline` — the account balance at the moment this session was first anchored. A **bookmark**, not a
  spending base.
- `spent` — the session's accumulated counter of observed **balance decreases**; monotonically
  non-decreasing.
- `lastBalance` / `ts` — bookkeeping for the previous observation and for pruning.

The account balance is shared by all sessions; the counters are per session. The account-level figure is
just the sum of every counter (`accountLevelDelta`) and exists only as a panel reference.

### 2.2 Reading a balance: `observeRead`

```text
previous = store.lastObservedBalance ?? entry.lastBalance ?? entry.baseline ?? balance
verdict  = classifyRead(previous, balance, tokenEstimate)

spend → entry.spent += amount
topup → reanchorAll(balance, ...)     // baselines move, spent does not
else  → bookkeeping only
```

First sight of a session creates the entry and counts nothing. `previous` deliberately prefers
`store.lastObservedBalance`: the balance is account-wide, so consecutive reads may come from different
sessions and must still be compared against the last value *anyone* saw.

### 2.3 Why the counter replaced anchor subtraction

The first design was `spend = anchor − current balance`. It works for one session and breaks in two ways:

- **After a top-up** the expression goes to zero or negative and stays there until spending falls back
  below the old anchor: spending appeared to *pause*. That was the original user complaint.
- **Its parallel extension was wrong.** The tempting account-level formula was
  `Σ(baselines) − current balance`. Every session's baseline observes the *same* account balance at a
  *different* moment, so summing them double-counts everything spent before the later session started. If
  session A anchors at ¥100, session B anchors later at ¥95 (¥5 already spent) and the balance is now ¥90,
  then `Σ anchors − balance` gives 195 − 90 = **¥105**, while the account has only ever spent **¥10**.
- **The correct account-level anchor is the earliest one, which is also the largest one.** The balance
  decreases monotonically between top-ups, so the earliest observation has the highest value and the
  earliest anchor is `Math.max` of the anchors. An earlier attempt used `Math.min` — the most recent,
  smallest observation — which turns the direction backwards: the difference becomes small or negative, so
  adding a new session makes recorded spending shrink. `Math.min` was a direction bug, not a rounding bug.

The v4 model discards anchor subtraction entirely: spending is a counter fed by observed decreases, and
anchors survive only as the reference point used to classify a read. Three properties follow at once —
top-ups cannot pause the counter, per-session attribution falls out naturally, and the counter never needs
to know which session "caused" a decrease.

> **Stale comment warning.** The doc comment on `readStore()` in `lib/client.js` still describes
> `account spend = Σ(baselines) − current balance` as if it were current, *and* claims that formula is
> accurate. It is neither current nor correct — a leftover from the anchor era. Treat the code as
> authoritative, and fix the comment when you touch that function.

### 2.4 Top-up classification is a pure function

```js
classifyRead(previousBalance, balance, tokenEstimate) → { kind, amount }
```

| Condition | Verdict |
| --- | --- |
| `previousBalance` is not a number | `flat` |
| `|balance − previous| <= 0.0001` | `noise` |
| `balance < previous` | `spend`, amount = the decrease |
| `balance − previous > tokenEstimate + 0.02` | `topup`, amount = the increase |
| otherwise | `noise` |

Keep it pure: it is exported through `__test`, the smoke suite asserts on it directly, and `observeRead`
is its only production caller. The idea behind the bound is that **the platform can never have charged
more than the consumed tokens are worth**. If the balance rises by more than the worth of every token
spent since the last read, the surplus cannot have come from consumption — only from money added
externally (top-up, bonus grant, billing correction). The threshold therefore scales with usage instead
of being a hand-picked epsilon, and it cannot be fooled by "top-up and spend in the same window". The
`+0.02` tolerance (`TOPUP_TOLERANCE`) only absorbs floating-point and rounding noise.

`reanchorAll(balance, amount, sessionId)` then sets **every** session's `baseline` and `lastBalance` to the
new balance, leaves every `spent` untouched, and pushes the event onto the in-memory `topups` list (capped
at 10). Re-anchoring all sessions is mandatory: the balance is account-wide, so a session left behind
would count the top-up as spending on its next read.

### 2.5 The three layers

1. **Token-bound rule** — `classifyRead`, pure client side, always on: the authority.
2. **Official bonus confirmation** — after a detected top-up the client reads the bonuses route and, if
   there are grants whose `orderId` it has not seen, reports their sum as corroboration. Failure degrades
   to an empty list and can never block or veto layer 1.
3. **Manual fallback** — the panel button calls `markTopUp(total)`, which takes the same `reanchorAll`
   path (it never fabricates a `spent` change) and then queries the bonuses route, so the "querying…"
   state reflects real work.

Only layers that re-anchor may change the baseline; none of them may touch `spent`.

---

## 3. Apportionment, and why it is only an estimate

The balance is account-level, so "what did *this* session cost" is not observable locally. The plugin
divides the session's own accumulated spend by the session's share of total token cost:

```text
ownTokens   = costOf(thisSessionUsage, model, peak).total
otherTokens = Σ costOf(session_i usage, model, peak)   for every tracked session i ≠ this one
allTokens   = ownTokens + otherTokens
ownActual   = allTokens > 0 ? sessionSpent × (ownTokens / allTokens) : 0
```

- **Every** session is priced with the same model id and the same peak/off-peak tier inside one render,
  otherwise the weights are not comparable. `tokensOf(id, model, peak)` exists for exactly that and
  returns 0 when a session's `tokenUsage` projection is unreachable.
- A single session gives `ownTokens === allTokens`, so the weight is 1 and the value is exact.
- Zero total cost yields 0, not the full amount: "there is nothing to apportion" is the honest answer.
- It is an **estimate**. Sessions do not burn tokens in lockstep with platform settlement, and a session
  joining the denominator makes the share step down once. Never present it as the real charge.

The **card** shows a smoother variant so the number grows instead of jumping every poll. At each
successful balance refresh the client records a confirmed pair `(ownTokens, apportioned)` and between
refreshes renders:

```text
ownEstimate = confirmed.apportioned + max(0, ownTokens - confirmed.ownTokens)
```

The confirmed pair is written **inside the balance effect**, using the store it just read, not during
render — writing refs during render risks reading a half-updated state.

> **Divergence risk.** The formula exists in two places: `ownActual` at render time and the confirmed-pair
> computation inside the balance effect. They must stay identical, including the `allTokens > 0` guard.
> If you change one, change both — or extract a helper and call it from both paths.

---

## 4. Persistence: schema, migration, pruning

Key: `dsh-balance-hud:tracker:v4`. Shape written by `writeStore`:

```json
{
  "sessions": {
    "<session id>": { "baseline": 43.42, "lastBalance": 43.12, "spent": 0.3, "ts": 1780000000000 }
  }
}
```

`writeStore` currently persists **only** `sessions`. The richer in-memory store object also carries
`topups[]` and `lastObservedBalance`, which live for the page lifetime but are dropped on write; do not
build features that assume either survives a refresh without changing the writer.

**Pruning (on every write):** drop entries whose `ts` is not a number or is older than 30 days
(`TRACKER_MAX_AGE_MS`), sort the rest by `ts` descending, keep at most 30 (`TRACKER_MAX_SESSIONS`).

**Migration chain.** `readStore()` reads v4 first; if it is absent it walks the legacy keys `v3 → v2 → v1`
and normalises whichever it finds:

| Version | Legacy shape | Recognised by |
| --- | --- | --- |
| v3 | `{ sessions: { [id]: { … } } }` | `legacy.sessions` is an object |
| v2 | `{ [id]: { … } }` | none of the above; flat dictionary |
| v1 | `{ sessionId, baseline, start, ts }` | `typeof legacy.sessionId === 'string'` |

All three fall out to the same `{ sessions: {} }` map: entries without a numeric `ts` are dropped, the
obsolete `start` field is deleted, `topups` is carried over when it is an array, the legacy key is
removed, and the result is written back as v4. `createTracker` then defaults `spent` to 0, so an
anchor-era record is upgraded without inventing spending.

`localStorage` access is wrapped in `try/catch` throughout: when storage is unavailable (private mode,
embedded webview) the plugin degrades to memory-only and everything except survival across refreshes
keeps working.

---

## 5. Things that bit us

- **The Cordis inject guard.** See §1. The failure that hurt most was not the thrown error but that the
  *other* fix (`inject = ["remote"]`) produced a silently hanging fiber. If the HUD disappears entirely
  rather than showing stale data, check the client `inject` list first.
- **The React runner must honour `useRef(initial)`.** The smoke runner keeps refs in hook slots that
  persist across renders, and both it and the verify-install stub initialise `current` from the argument. The component depends on this: `confirmedRef` is created with `{ sessionId: undefined, … }`
  and read on the very first render, before any balance refresh has run. A shim returning
  `{ current: null }` (or ignoring a function initialiser) makes the harness crash or silently produce
  wrong baselines, which then looks like a plugin bug.
- **A plain object used as shared state does not re-render.** The anchor store lives in a closure
  (`baselineStage.store`), so mutating it does not notify React. The apportionment denominator is read
  from that store during render, so without a nudge the denominator only ever contained the current
  session — the share was 100% and **every session displayed the same number**. The fix is the `epoch`
  state plus `bumpEpoch()`: the value is unused, its only job is to force a re-render after the store
  changes. Do not "clean up" that apparently dead state.
- **`Math.min` vs `Math.max` on anchors.** See §2.3. The direction of the account-level anchor was
  backwards for a while, and because both formulas look plausible, only a concrete before/after example
  catches it. The same applies to the two copies of the apportionment formula (§3), which can silently
  drift apart.
- **`HUD_VERSION` and stray comments.** `HUD_VERSION` is a leftover diagnostic constant that used to be
  shown in a native tooltip; it is now unreferenced — either wire it into the panel or drop it, but do not
  reintroduce `title`. Likewise, several comments (and older docs) still say the balance is polled every
  30 seconds; `BALANCE_POLL_MS` is 60 000 and `BALANCE_POLL_HIDDEN_MS` is 300 000. Trust the constants.
- **No `title` attributes, ever.** A native tooltip pops up as a black box about a second after hover and
  covers the HUD, fighting the custom panel. Accessibility text goes into `aria-label`; the smoke suite
  asserts that no `title` exists on the card or its cells.
- **Hover is judged per element, not per container.** The panel (286 px) and the card (~96 px, right
  aligned) do not form a rectangle, so any single containing box has dead space where the pointer is
  "inside the container" but over neither element — sliding left there would not close the panel. The
  card and the panel therefore carry their own `mouseenter`/`mouseleave`, a 140 ms close delay lets the
  pointer cross the 8 px gap, and the shared wrapper only handles alignment and the gap. That is why the
  panel is an in-flow child of the wrapper instead of `position: fixed` with a hard-coded offset.

---

## 6. Testing strategy

`node tools/smoke.mjs` is the workhorse and needs no DSH installation and no network:

- It evaluates the **real** `lib/client.js` with `new Function(...)`, captures the
  `window.__ModuleLoader__.load(...)` record, then calls `factory(requireShim)` and `apply(fakeCtx)` the
  way the real loader would. Point `DSB_HUD_CLIENT` at another copy to test an installed profile build.
- The fake React runner is a hook-slot interpreter: `useState`, `useEffect` (dependency comparison and
  cleanups), `useRef`, a selector-capable `useSessions` share, batched `flushState`, `flushEffects`, and a
  `settle()` that lets `fetch` promises land. Each mount runs several render passes so it observes the
  tree *after* async state commits.
- Fakes for `fetch` (per-mode host responses), `localStorage` and `document` (visibility plus pointer
  events). The fetch mock throws on any URL other than the two plugin routes and on any method other than
  `GET` — a regression guard for the relay contract.
- It prints one `✓` line per check (47 of them) and throws on the first failure.

Regression guards worth knowing, because each encodes a deliberate decision:

| Asserted | Why it exists |
| --- | --- |
| No `title` anywhere on the card | The native tooltip black box must not come back |
| Card is `inline-grid`, two columns, exactly four cells | A previous horizontal layout covered the session list |
| Card money = 2 decimals, panel money = 4, `<¥0.01` / `<¥0.0001` sentinels | Sub-cent spending must never read as `0.00` |
| Hover opens; crossing to the panel keeps it open; leaving the **left** edge of card *or* panel closes it | The non-rectangular hover surface in §5 |
| Refresh shows "refreshing…" then an `updated HH:MM:SS` stamp; manual top-up shows "querying…" | Buttons need visible, work-backed feedback |
| A top-up raises the balance but leaves `spent` unchanged, and spending continues afterwards; `reanchorAll` moves **all** sessions' baselines and none of their counters | The core promise of the current model, with an account-wide balance |
| Counter survives a simulated refresh; per-session records do not cross; `classifyRead` maps decrease/rise/tolerance correctly | Persistence and the classifier |
| v3 / v2 / v1 migration, 30-day pruning, 30-session cap, no-`localStorage` degradation | Upgrade safety |
| Returning to the foreground triggers an immediate refetch | Visibility handling |

What it does **not** cover, and where to look instead:

- **The Host half.** Nothing in `smoke.mjs` loads `lib/index.js`; the loopback filter, route registration,
  `normalize()` and `normalizeBonuses()` have no offline test. `tools/verify-install.mjs` only checks that
  the Host module imports and exports `apply`/`name`/`inject`, which is not the same thing. Adding a small
  host-route test is the most valuable missing piece.
- **Real browser, real layout, real Cordis/DSH/platform.** Rectangles, `mouseenter` ordering and CSS
  variables are simulated, so visual regressions slip through; the inject guard of §1, platform settlement,
  and poll timing within a single pass are all out of reach.

`tools/verify-install.mjs` covers the other axis: that the package resolves, that `dsh.bundle.patch` and
`dsh.client` are declared correctly, that the patch file inserts the plugin, that the client bundle
registers exactly one module and `require`s nothing at registration time, and that the Host entry imports.
Run it with `--package` for the repository copy, or with `--profile <dir>` (or `DSH_PROFILE_DIR`) for an
installation.
