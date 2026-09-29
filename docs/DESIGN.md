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

Each session's record is `{ baseline, lastBalance, lastRead, spent, ts }`:

- `baseline` — the account balance at the moment this session was first anchored. A **bookmark**, not a
  spending base; an external balance change moves it.
- `spent` — the session's accumulated counter of observed **balance decreases classified as spending**;
  monotonically non-decreasing.
- `lastRead` — the balance **this session** actually observed last, and the only preferred comparison
  point for its next read. Session-private: an external change never writes it (see §2.2).
- `lastBalance` / `ts` — the account-level balance after the last event, and pruning bookkeeping. Both
  are fallbacks for reads that predate `lastRead`.

The account balance is shared by all sessions; the counters are per session. The account-level figure is
just the sum of every counter (`accountLevelDelta`) and exists only as a panel reference.

### 2.2 Reading a balance: `observeRead`

```text
previous = previousBalanceOf(entry, store)   // entry.lastRead → entry.lastBalance → entry.baseline
                                             // → store.lastObservedBalance
verdict  = classifyRead(previous ?? balance, balance, tokenEstimate)

spend  → entry.spent += amount
topup  → applyExternalChange(balance, amount, sessionId, 'topup')
expire → applyExternalChange(balance, amount, sessionId, 'expire')   // identical path
else   → bookkeeping only
```

First sight of a session creates the entry and counts nothing. `previous` deliberately prefers
`entry.lastRead` — the balance **this session** observed last — rather than a store-wide value: the
balance is account-wide, so consecutive reads may come from different sessions, but an external change
moves only the account-level fields (`baseline`, `lastBalance`) and deliberately never `lastRead`. Every
session therefore still sees the full drop/rise and classifies the event itself, instead of charging it
to its own spending. The remaining fallbacks exist only for records migrated from a version that predates
`lastRead`.

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
an external change in either direction cannot pause the counter, per-session attribution falls out
naturally, and the counter never needs to know which session "caused" a decrease.

> **Stale comment warning.** The doc comment on `readStore()` in `lib/client.js` still lists the record
> shape as `{ baseline, lastBalance, spent, ts }`, omitting `lastRead`. (It no longer repeats the
> anchor-era `account spend = Σ(baselines) − current balance` claim — that was fixed.) Trust the code,
> and update the comment when you extend the record.

### 2.4 External-change classification is a pure function

```js
classifyRead(previousBalance, balance, tokenEstimate) → { kind, amount }
```

| Condition | Verdict |
| --- | --- |
| `previousBalance` is not a number | `flat` |
| `abs(balance − previous) <= 0.0001` | `noise` |
| `balance − previous > tokenEstimate + 0.02` | `topup`, amount = the increase |
| increase within the bound | `noise` |
| `previous − balance > tokenEstimate + 0.02` | `expire`, amount = the decrease |
| decrease within the bound | `spend`, amount = the decrease |

Keep it pure: it is exported through `__test`, the smoke suite asserts on it directly, and `observeRead`
is its only production caller. The idea behind the bound is that **the platform can never have charged
more than the consumed tokens are worth** — and the rule is applied in **both** directions, because the
symmetric statement also holds: the platform cannot have charged for tokens that were not consumed, so a
drop larger than the worth of every token spent in the window cannot have come from consumption either.
The threshold therefore scales with usage instead of being a hand-picked epsilon, and it cannot be fooled
by "top-up and spend in the same window". The `+0.02` tolerance (`TOPUP_TOLERANCE`) only absorbs
floating-point and rounding noise.

**The reduction direction is what makes bonus expiry survivable.** A grant that lapses is reclaimed by
the platform and the balance drops with no token consumption behind it. The pre-fix classifier returned
`spend` for *every* negative delta, so a ¥5 expiry was added to the session counter — and since the
counter only grows, the error stayed there until the entry was pruned.

`applyExternalChange(balance, amount, sessionId, kind)` then sets **every** session's `baseline` and
`lastBalance` to the new balance, leaves every `spent` untouched, deliberately leaves every `lastRead`
alone (§2.2), and pushes `{ at, amount, sessionId, kind }` onto the in-memory `topups` list (capped at
10). Re-anchoring all sessions is mandatory: the balance is account-wide, so a session left behind would
count the change as spending on its next read. `kind` (`'topup'` or `'expire'`) is the only difference
between the two directions, and both share this one path.

### 2.5 The three layers

1. **Token-bound rule** — `classifyRead`, pure client side, always on: the authority, in both directions.
2. **Official bonus confirmation** — after a detected top-up the client reads the bonuses route and, if
   there are grants whose `orderId` it has not seen, reports their sum as corroboration. This layer only
   ever corroborates **grants**: the platform exposes no "expired" feed (the route returns pending grants,
   not lapses), which is exactly why the token bound has to be the authority in the reduction direction.
   Failure degrades to an empty list and can never block or veto layer 1. `normalizeBonuses` also passes
   `expiresAt` through so the notice can name the earliest lapse date; that field never feeds the
   accounting decision.
3. **Manual fallback** — the panel button calls `markTopUp(total)`, which takes the same
   `applyExternalChange(…, 'topup')` path (it never fabricates a `spent` change) and then queries the
   bonuses route, so the "querying…" state reflects real work.

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

## 4. Settings, budgets and peak warnings

### 4.1 Two slot registrations, no common React ancestor

The plugin registers **two** independent slots:

| Slot | Id | Component |
| --- | --- | --- |
| `shell.overlay` | `balance-hud` | `BalanceHud` — the fixed bottom-right overlay |
| `settings.general.item` | `balance-hud-settings` | `BalanceHudSettingsRow` — the preference row |

`settings.general.item` is DSH's declared seat for *"one preference row inside the General section —
the additive seat for a single setting that needs no page of its own (a whole page is
`settings.section`)"* — the same slot DSH uses for its own Language, link-opening and
performance-usage rows. Taking a row rather than a page is deliberate: this plugin owns one small
setting cluster, not a settings surface, and the slot is explicitly additive.

The two registrations render into **different parts of the tree and share no React ancestor**, so they
cannot share React state. They share a small subscription container instead — `createSettingsStore()`
returns `{ get, set, subscribe }`:

```text
set(patch) → normalize({ ...current, ...patch }) → save → broadcast to every listener
```

`set` therefore **merges a partial patch** — the row sends only the field it edited — and broadcasts
the merged result, so editing in either place updates the other immediately and both read the same
object. `useSettings(store, useState, useEffect)` is the React binding: it seeds from `store.get()`
and subscribes. That is why neither component needs the other as a parent, and why the row may render
before the overlay (or vice versa) with no ordering rule to maintain.

### 4.2 Sanitise at the boundary: `normalizeSettings`

The settings blob lives in `localStorage` under `dsh-balance-hud:settings:v1` — a key deliberately
**separate** from the accounting key `dsh-balance-hud:tracker:v4`, so the two can never interfere.
Everything read from it is **untrusted input**: the user can edit it by hand, and an older version can
leave behind fields that no longer exist.

`normalizeSettings(raw)` therefore validates **field by field against whitelists** and returns a fresh
object; `loadSettings()` wraps the parse in `try/catch`, so corrupt JSON falls back to
`defaultSettings()` instead of throwing:

| Field | Rule | On violation |
| --- | --- | --- |
| `model` | must be in `MODEL_CHOICES` | default `deepseek-flash` |
| `pollSeconds`, `hiddenPollSeconds` | must be in `POLL_CHOICES` (30/60/120/300) | 60 / 300 |
| `showAccountTotal`, `notifyBudget`, `notifyPeak` | must be a real boolean | defaults |
| `sessionBudget` | finite number, 0–100 000 | 0 (unset) |
| `dailyBudget` | finite number, 0–1 000 000 | 0 (unset) |
| `peakWarnMinutes` | must be in `PEAK_WARN_CHOICES` (5/10/15/30) | 10 |

The rule generalises: **anything user-writable and version-dependent is re-validated on every load and
never trusted.** A dirty value must never be able to crash the HUD or reach the price table.

### 4.3 The budget model, and why the card gets a border instead of a cell

```text
evaluateBudget(spent, budget) → { level, ratio, remaining }
  budget <= 0 or spent not a number → { level: 'none', ratio: 0, remaining: undefined }
  ratio >= 1.00 → 'over'    ratio >= 0.90 → 'critical'    ratio >= 0.75 → 'warn'    else 'none'
  remaining = max(0, budget − spent)
worstBudgetLevel([session, daily]) → the more severe of the two
```

`BUDGET_STEPS` is checked highest-first, so a ratio of 1.2 is `over`, not `warn`. `remaining` is
clamped at 0, because a negative remainder is never a useful thing to show. The card colours itself
from `worstBudgetLevel`, not from the session budget alone: an exhausted daily budget warns even when
this session is still cheap.

**The visual is a 3 px coloured left border, deliberately not a fifth grid cell.** The card is a
two-column grid whose rows are `Balance` / `Session est.`, and the smoke suite asserts exactly four
cells and those two labels. Growing the grid to carry a budget cell would break that alignment
contract for a state that is transient and better expressed as emphasis. The border uses the existing
theme variables (`--dsw-alias-label-warning` for warn/critical, `--dsw-alias-label-error` for over)
and compensates with `paddingLeft`, so the text does not shift when it appears.

The notification path is **optional and bounded**: `notifyBudget` defaults to `false`, sending needs
`Notification.permission === 'granted'`, and a `Set` of already-notified levels keeps it to **at most
one notification per level per mount**. A budget that stays over for an hour therefore notifies once,
not on every poll; if permission is missing the plugin silently keeps the border only.

### 4.4 The daily ledger is a Beijing day fed by *confirmed* spend

Key `dsh-balance-hud:daily:v1`, shape `{ date, total }`:

```text
beijingDateKey(now)   → 'YYYY-MM-DD' for the Beijing calendar day (UTC+8; no timezone library)
loadDaily()           → if the stored date ≠ today: write { today, 0 } and return 0
addDailySpent(amount) → amount > 0 ? total + amount : unchanged
```

Two decisions matter:

- **Beijing day, not the local day.** The official price tiers and billing windows are all
  Beijing-based, so the daily-budget boundary must use the same clock. A local-midnight reset would
  roll the day over in the middle of a Beijing peak window for most users.
- **Confirmed spend only.** `addDailySpent` has exactly one caller: the balance effect, guarded by
  `verdict.kind === 'spend' && verdict.amount > 0` — the amount a realised balance read **confirmed**
  as spending. It is never fed the interpolated `ownEstimate` shown on the card: that value grows
  smoothly between reads, so adding it here would re-count the same money on every tick. Non-positive
  amounts are ignored, so a `topup` or an `expire` classification can neither add to nor subtract from
  the day.

Because `loadDaily` rewrites the record whenever the stored date differs, opening the HUD the next
morning starts the day at 0 with no reset job of its own. The ledger is a single record, not a
history — only "today" is meaningful to the daily budget.

### 4.5 Peak countdown maths

`minutesUntilTierChange(now)` returns `{ minutes, to }`, where `to` is `'peak'` (the next change enters
peak) or `'off'` (the next change returns to off-peak). Peak windows are Beijing **Mon–Fri
09:00–12:00 and 14:00–18:00**, and peak price is exactly **2×** off-peak in `PRICES`, so the countdown
is real money information.

All arithmetic goes through `beijingClock(now) → { minutes, day }` (minutes since Beijing midnight plus
the weekday). The cases:

| Situation | Result | `to` |
| --- | --- | --- |
| Weekday before 09:00 | 09:00 − now | `peak` |
| 09:00–12:00 | 12:00 − now | `off` |
| 12:00–14:00 (lunch) | 14:00 − now | `peak` |
| 14:00–18:00 | 18:00 − now | `off` |
| Weekday after 18:00 | wrap to tomorrow 09:00 | `peak` |
| Saturday | to Monday 09:00 (2 days) | `peak` |
| Sunday | to Monday 09:00 (1 day) | `peak` |

Worked examples, all asserted by the suite: Friday 18:30 → Monday 09:00 is
`24*60 − 1110 + 540` = **870 minutes**; Saturday 12:00 → Monday 09:00 is **2700 minutes** (45 h);
Monday 09:30 → 12:00 is **150 minutes** (`off`); Monday 17:50 → 18:00 is **10 minutes** (`off`).

> **Why the weekend gets its own branch.** On a weekday it is enough to search `PEAK_WINDOWS` for the
> first window start greater than the current minute; on a weekend there is no window at all that day,
> so the code jumps to Monday 09:00 explicitly (`day === 6 ? 2 : 1` days, minus the current minute
> offset, plus 540). Getting this wrong is invisible Monday–Friday and wrong all weekend.

A fixed **60-second tick** (`setInterval(…, 60000)`) increments a clock state and re-reads
`loadDaily()`, so both the countdown and the day rollover stay live without any scheduling logic of
their own. The panel shows the warning only when `notifyPeak` is on and the next change is within
`peakWarnMinutes`: `约 N 分钟后进入峰时，价格翻倍` for `to === 'peak'`, and
`约 N 分钟后回到闲时价` for `to === 'off'`.

---

## 5. Persistence: schema, migration, pruning

Key: `dsh-balance-hud:tracker:v4`. Shape written by `writeStore`:

```json
{
  "sessions": {
    "<session id>": { "baseline": 43.42, "lastBalance": 43.12, "lastRead": 43.12, "spent": 0.3, "ts": 1780000000000 }
  }
}
```

`writeStore` currently persists **only** `sessions`. The richer in-memory store object also carries
`topups[]` and `lastObservedBalance`, which live for the page lifetime but are dropped on write; do not
build features that assume either survives a refresh without changing the writer.

Two writers touch a record, and **both are lossless**. `observeRead` mutates the record in the store
object and hands the whole store to `writeStore`, so it carries every field. `persistTracker` (used by
`checkoutSession`) reads the record already on disk, takes it as the merge base
(`{ ...(store.sessions[id] ?? {}) }`), and only overwrites a field the caller actually holds: `baseline`
always (it returns early without one), `spent` only when numeric, `lastRead` / `lastBalance` only when
numeric, plus `ts`. So it neither drops `lastRead` nor writes `lastBalance: undefined` — a value
`JSON.stringify` would silently delete. Extend every writer whenever you add a per-session field — see §6.

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

## 6. Things that bit us

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
- **A lossy record round trip silently ate real spending — in two places.** `createTracker` used to map
  only a subset of fields. When `lastRead` was added, that field was dropped on the read → modify → write
  round trip, so `previousBalanceOf` fell back to `lastBalance` — an *event* balance that other sessions
  also write — and swallowed a whole window of genuine spending. `persistTracker` had the same class of
  bug from the other end: it rebuilt the record from a fixed field list (`baseline`, `lastBalance`,
  `spent`, `ts`), so it dropped `lastRead` as well and additionally wrote `lastBalance: undefined`, which
  `JSON.stringify` deletes outright. Nothing in the UI said so; the counter simply under-reported. Both
  writers are fixed, and the fix is the same property in each: `createTracker` spreads the persisted
  record and only fills defaults, and `persistTracker` merges into the on-disk record as its base and
  only overwrites fields the caller holds. That is why the invariant is written down twice — here and in
  §5: **any writer that rebuilds a record from a fixed field list is lossy.** When you add a per-session
  field, extend every writer that touches the record.
- **A single bridge field carrying two meanings was a dead end.** An earlier attempt to recover "spending
  that happened before the external change was observed" added a reanchor-bridge field that stood for
  both "the balance this session last read" *and* "the balance at the event". The two meanings are
  written by different actors — the session's own reads versus a possibly different session's event — so
  the field was repeatedly clobbered and real spending was lost again. `lastRead` carries exactly one
  meaning, and the fallback chain in `previousBalanceOf` keeps the other values as read-only legacy
  fallbacks. Do not reintroduce a dual-purpose field.
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

## 7. Testing strategy

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
- It prints one `✓` line per check (64 of them) and throws on the first failure.

Regression guards worth knowing, because each encodes a deliberate decision:

| Asserted | Why it exists |
| --- | --- |
| No `title` anywhere on the card | The native tooltip black box must not come back |
| Card is `inline-grid`, two columns, exactly four cells | A previous horizontal layout covered the session list |
| Card money = 2 decimals, panel money = 4, `<¥0.01` / `<¥0.0001` sentinels | Sub-cent spending must never read as `0.00` |
| Hover opens; crossing to the panel keeps it open; leaving the **left** edge of card *or* panel closes it | The non-rectangular hover surface in §6 |
| Refresh shows "refreshing…" then an `updated HH:MM:SS` stamp; manual top-up shows "querying…" | Buttons need visible, work-backed feedback |
| A top-up raises the balance but leaves `spent` unchanged, and spending continues afterwards; `applyExternalChange` moves **all** sessions' baselines and none of their counters | The core promise of the current model, with an account-wide balance |
| Bonus expiry: a drop beyond the token bound classifies as `expire`, leaves `spent` unchanged, moves the baseline down, and spending resumes normally afterwards; a drop *within* the bound — including exactly at the bound — still counts as `spend` | The regression guard for the reduction direction, i.e. the reason the bound is applied both ways |
| An expiry triggered from session A moves every session's baseline but not their counters; session B, which has not read since, still compares against **its own** `lastRead` and charges its own ¥5.50 to spending | Pins `previousBalanceOf`'s preference for `lastRead` and the multi-session self-heal |
| Counter survives a simulated refresh; per-session records do not cross; `classifyRead` maps rise/drop/bound/tolerance correctly | Persistence and the classifier |
| Switching in through `checkoutSession` leaves a session's `baseline` / `lastRead` / `lastBalance` / `spent` untouched, and the persisted blob contains no `undefined` field | The lossless round trip of §5/§6: a record rebuilt from a field list under-reports spending with no visible symptom |
| v3 / v2 / v1 migration, 30-day pruning, 30-session cap, no-`localStorage` degradation | Upgrade safety |
| Returning to the foreground triggers an immediate refetch | Visibility handling |
| Exactly **two** slot registrations — `shell.overlay` (id `balance-hud`) and `settings.general.item` (id `balance-hud-settings`) — with the overlay's `name`/`id` asserted and the settings row asserted to be registered | Catches a registration that silently stops firing (a broken `ctx.slots.inject`, a renamed slot). Any new registration must update this count (see CONTRIBUTING) |
| Settings: defaults are `deepseek-flash` / 60 s / unset budgets; dirty config sanitises field by field while legal values survive; a save/load round trip; the container broadcasts, merges a partial patch and honours `unsubscribe`; corrupt JSON falls back to defaults without throwing | The boundary rule of §4.2 — user-writable config is re-validated on every read, never trusted |
| Budget: 75 % → `warn`, 90 % → `critical`, ≥ 100 % → `over`, `remaining` clamped at 0, and `worstBudgetLevel` takes the more severe of the session and daily budgets | The thresholds and clamping of §4.3, including the "daily exhausted, session cheap" case |
| Daily ledger: accumulates confirmed spend, ignores 0 and negative amounts, resets to 0 when the Beijing date changes, and falls back to 0 on corrupt content | The confirmed-spend-only rule and the Beijing day boundary of §4.4 |
| Peak countdown: entering peak from off-peak, returning to off-peak from peak, across the lunch break, and Friday 18:30 → Monday 09:00 | The overnight and weekend branches of §4.5, which are invisible Monday–Friday |

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
