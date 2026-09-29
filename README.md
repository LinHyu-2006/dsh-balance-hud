**English** | [简体中文](README.zh-CN.md)

# dsh-balance-hud

An always-on HUD in the bottom-right corner of the **DSH (DeepSeek Harness)** Web GUI that shows your
DeepSeek **account balance** and the **cost of the current session**.

[简体中文说明](README.zh-CN.md) · [Design notes](docs/DESIGN.md) · [设计说明](docs/DESIGN.zh-CN.md) · [LICENSE](LICENSE)

- **Account balance** — recharge balance + bonus balance, read through the same service the
  *Settings → Account & balance* page uses (`ctx.deepseekAccount.getBalance()`).
- **Two cost figures** — a token-based *estimate* from the official price table, and an *actual*
  figure accumulated from real balance decreases (external reductions excluded).
- **External balance changes, both ways** — a top-up raises the balance, and a lapsed bonus grant is
  reclaimed by the platform; money moving in or out externally never touches the spending counter.
- **Per session** — the tracker is keyed by session id; refreshing the page or switching sessions
  never damages or clobbers another session's record, because the read → modify → write round trip
  is lossless.
- **No credentials, no outbound network of its own** — the plugin never touches your API key.
- **Two halves, one relay** — a browser half renders the HUD; a Host half exposes two read-only
  loopback HTTP routes so the browser can read the balance.
- **Configurable, and budgeted** — a preference row in *Settings → General* sets the model, the poll
  intervals, the budgets and the warnings; the card gains a coloured edge as spending approaches a
  budget, and the panel counts down to the next peak/off-peak switch.

```bash
node tools/install.mjs    # install into ~/.dsh/profiles/desktop, then restart DSH
node tools/smoke.mjs      # offline smoke suite (64 assertions), no DSH install needed
```

## The HUD

```text
                                                        ┌──────────────────────────────┐
                                                        │  Balance             ¥43.42  │
                                                        │  Session est.         ¥0.59  │
                                                        └──────────────────────────────┘
```

Hovering the card expands a detail panel: balance rows (recharge / bonus / total), the three priced
components of the estimate, the actual figure, token counts, and — with parallel sessions — the
apportionment rows (`Session share`, `Other sessions`, `Tracked sessions`, `Account total`). The
panel uses 4 decimals; the card uses 2. The shipped labels are currently Chinese; the English names
here are what each row means.

| Field | Meaning |
| --- | --- |
| Balance | Total account balance (recharge + bonus), 2 decimals |
| Session est. | Estimate for the current session; 2 decimals on the card, 4 in the panel; `—` when the session has no token usage yet |
| Actual charged | Accumulated real spending for this session (single session; becomes `Session share` when parallel) |

Amounts below the smallest displayed unit render as `<¥0.01` on the card and `<¥0.0001` in the
panel, so real spending is never rounded down to a flat zero.

## Interaction

- **Hover** the card and the detail panel expands; move away and it closes.
- The card and the panel are separate elements with an intentional **8 px gap** between them, and the
  pointer must be able to cross that gap without the panel closing. The hover decision is attached to
  the card and the panel themselves — each has its own enter/leave handler — never to the enclosing
  positioning container. A **140 ms** pending-close timer carries the card's `mouseleave` across the
  gap so the panel's `mouseenter` cancels it.
- Leaving the **left** edge of the card *or* the **left** edge of the panel closes the panel. This is
  deliberate: the container reserves extra space above and to the sides, so hanging the close
  behaviour on the container box would keep the panel open over dead space.
- **Click** the card to fold it down to a small corner badge showing 2 cells — label and balance;
  click again to restore it.
- **Keyboard:** the card is a `role="button"` with `tabIndex=0` and toggles the fold on `Enter` and
  `Space`. The panel is a `role="dialog"`.
- The panel header carries a **Refresh** button that immediately shows a busy label and then an
  `Updated at HH:MM:SS` timestamp, plus the manual *I just topped up* button, which shows a querying
  state while it works.
- **There are deliberately no `title` attributes anywhere in the HUD.** A native browser tooltip
  appears as an opaque black box about a second after hover and covers the panel, so the summary
  lives in `aria-label` instead — asserted by the smoke suite as a regression guard.

## Settings

The plugin contributes **one preference row** — `余额与花费 HUD` — to the DSH slot
`settings.general.item`, which DSH declares as *"one preference row inside the General section — the
additive seat for a single setting that needs no page of its own"* (a whole page is
`settings.section`; the same slot carries DSH's own Language, link-opening and performance-usage
rows). Find it at **Settings → General → 余额与花费 HUD**. It does **not** take over a whole settings
page.

| Setting | Values | Default | Effect |
| --- | --- | --- | --- |
| Model (`计价模型`) | `deepseek-flash`, `deepseek-v4-pro` | `deepseek-flash` | Price table used for the estimate and the apportionment weights |
| Foreground poll interval (`前台刷新间隔`) | 30 / 60 / 120 / 300 s | 60 s | Balance poll cadence while the page is visible |
| Hidden interval (`后台（页面隐藏）`) | 30 / 60 / 120 / 300 s | 300 s | Balance poll cadence while the page is hidden |
| Peak-warning lead time (`峰前提醒`) | 5 / 10 / 15 / 30 min | 10 min | How early the peak/off-peak warning appears |
| Session budget (`本会话预算（元）`) | CNY, `0` = unset | 0 | Budget for this session's estimated spend |
| Daily budget (`每日预算（元）`) | CNY, `0` = unset | 0 | Budget for the Beijing-day confirmed spend |
| Show account total row (`显示账户级合计`) | on / off | on | `Account total` row in the panel when parallel sessions exist |
| Peak warnings (`峰时提醒`) | on / off | on | The peak/off-peak warning line in the panel |
| System notification on budget breach (`预算超限发系统通知`) | on / off | off | Optional `Notification` when a budget level is first reached |

The shipped row is labelled in Chinese; the English names above are what each control means.

**Persistence.** The row writes the `localStorage` key `dsh-balance-hud:settings:v1` — deliberately
**separate** from the accounting key (`dsh-balance-hud:tracker:v4`), so the two can never interfere.

**Two registrations, one container.** The settings row (`settings.general.item`) and the HUD overlay
(`shell.overlay`) are **two independent slot registrations with no common React ancestor**, so they
cannot share React state. They share a small subscription container instead —
`createSettingsStore` → `get` / `set` / `subscribe`: `set` merges a partial patch, persists it and
broadcasts, so editing in either place updates the other immediately — no reload, no shared parent.
`useSettings` is the React binding on top of the same container.

**Dirty config is never trusted.** `normalizeSettings` validates **field by field against
whitelists**: an unknown model, an interval outside the choices, a negative budget or a non-boolean
toggle falls back to the default rather than propagating into the UI. Corrupt JSON in `localStorage`
also falls back to defaults instead of throwing. The config is user-writable and version-dependent,
so it is re-validated on every read.

## Budgets

Set a **session budget** and/or a **daily budget** (CNY; `0` means unset) in the settings row.

`evaluateBudget(spent, budget)` returns `{ level, ratio, remaining }`, with `level` one of
`none | warn | critical | over`:

| Usage | Level |
| --- | --- |
| < 75 % | `none` |
| ≥ 75 % | `warn` |
| ≥ 90 % | `critical` |
| ≥ 100 % | `over` |

`remaining` is clamped at 0, so "over budget" never reports a negative remainder. `worstBudgetLevel`
then picks the more severe of the session and daily budgets, so an exhausted daily budget still warns
while the session itself is cheap.

**Visual.** When a budget is at or over a threshold the card gets a **coloured 3 px left border** —
`warn` / `critical` use the theme warning colour, `over` the error colour. It is deliberately **not**
an extra grid cell: the card grid must stay **2 columns × 2 rows**, and the smoke suite pins that with
an assertion. The expanded panel adds a budget line showing spent / budget and either the remaining
amount or `已超限` (over budget).

**Optional system notification.** With *system notification on budget breach* enabled (off by
default), each level fires **at most once per mount**, so it cannot become a nag. It uses the browser
`Notification` API and only sends when permission has been granted; if it has not, the plugin silently
degrades to the coloured border only.

**The daily budget uses a per-day ledger.** The `localStorage` key `dsh-balance-hud:daily:v1` holds
`{ date, total }`, where `date` is the **Beijing** calendar day (`beijingDateKey`) — the official
billing and peak windows are both Beijing-based, so the day boundary follows the same clock. It only
accumulates **confirmed** spend — the value a balance read confirmed as spending — never the
interpolated display value, so the same money cannot be counted twice. Reading on a new day resets it
to 0.

## Peak-hour warnings

Peak windows are Beijing time **Monday–Friday 09:00–12:00 and 14:00–18:00**, and the peak price is
exactly **2×** the off-peak price. `minutesUntilTierChange(now)` returns `{ minutes, to }`, where `to`
is `'peak'` (about to enter the expensive window) or `'off'` (about to return to the cheap one).

The panel shows a warning line when the next tier change falls within the configured lead time:

- `约 N 分钟后进入峰时，价格翻倍` — entering the peak window in about N minutes; the price doubles.
- `约 N 分钟后回到闲时价` — back to off-peak pricing in about N minutes.

A **60-second tick** drives both the countdown and the daily rollover, so the numbers stay live while
the page is open. The countdown is correct across the lunch break, overnight and weekends — e.g.
Friday 18:30 → Monday 09:00 is **870 minutes** — and the smoke suite asserts those cases.

## The two cost figures

| Figure | How it is computed | Nature |
| --- | --- | --- |
| **Estimate** | Session `tokenUsage` projection × the official price table | Exactly computable, but covers model tokens only |
| **Actual** | Accumulated sum of observed **balance decreases classified as spending** (drops beyond the token bound are external reductions and are excluded), stored per session in `localStorage` | What the platform really charged, but settled with a delay |

The estimate splits usage into four token classes — uncached input, cache hit, cache write and
output — and prices each class with peak/off-peak rates. **Cache writes are charged at the
cache-miss rate**, matching how the platform bills them. The actual figure is a **counter, not a
subtraction**: every observed balance drop is added to the current session's counter, so neither a
top-up nor an externally reclaimed bonus can disturb it.

## Top-ups and other external balance changes

**Principle: money entering or leaving the balance from outside changes the balance but must not
change the spending counter.**

The classifier applies the **token-estimate upper bound** in *both* directions rather than an
arbitrary epsilon:

```text
balance rise > total token estimate + 0.02  →  externally added money      (topup)
                                               top-up, bonus grant, billing correction
balance drop > total token estimate + 0.02  →  externally removed money    (expire)
                                               bonus expiry, refund reversal, billing correction
everything else                             →  ordinary spending, accumulate as usual
```

The platform can never have charged more than the tokens consumed are worth, so a bigger rise must
have come from outside. Symmetrically, it cannot charge for tokens that were not consumed: a drop
larger than the worth of every token spent in the window cannot have come from consumption either.
The *same* bound therefore catches a bonus expiry as well, survives a "top-up and spending at the
same time" event, and cannot be triggered by normal spending noise.

**Why the reduction direction exists: bonus expiry.** A bonus grant that lapses is reclaimed by the
platform, so the balance drops with no token consumption behind it. The previous implementation
classified *every* decrease as spending (`if (delta < 0) return { kind: 'spend', amount: -delta }`),
so a ¥5 bonus expiring was recorded as ¥5 of session spending — and because the counter only grows,
the error stayed in the record until the entry was pruned.

Both directions take the **same code path** (`applyExternalChange`): only the account-level bookmark
moves — every session's `baseline` and `lastBalance` — while `spent` is left untouched, and the
event is appended to the `topups[]` history carrying its `kind` (`'topup'` or `'expire'`). Because
the balance is account-wide, one event re-anchors **every** session. The function deliberately never
touches `lastRead` — "the balance this session actually observed last" is session-private — so a
session that has not yet observed the change still sees the full drop on its next read and
classifies it as an external change instead of charging it to its own spending. Each session
self-heals, and the event is not double-counted because the session that triggered it already
advanced its own `lastRead`.

Three layers, in order of authority:

1. **The token-bound rule** — pure client side, always active: the authority in both directions.
2. **Official bonus-grant confirmation** — `GET /api/balance-hud/bonuses` reads
   `ctx.deepseekAccount.getUnnotifiedBonuses()`. It is **read-only and deliberately does not call
   `ackBonusNotified`**, so it never consumes DSH's own bonus notifications; the data stays
   readable and the client de-duplicates by `orderId`. This layer corroborates **grants** only:
   there is **no official "expired" feed**, which is exactly why the token bound has to be the
   authority in the reduction direction. If the route is unreachable a top-up is still detected —
   this layer is only corroboration. `normalizeBonuses` also passes `expiresAt` through (it is
   **not** what the accounting decision uses) so the notice can name the earliest lapse date.
3. **A manual fallback** — the *I just topped up* button takes the same re-anchor path and shows a
   "querying…" state while it re-anchors and queries the bonuses route.

**Notices.** An external change in either direction shows a one-line notice in the panel for about
12 seconds:

- a top-up: `已识别充值 ¥50.00，花费继续累计（官方赠金 ¥5.00 印证），最早到期 2025-12-31。` —
  "recognised a ¥50.00 top-up; spending keeps accumulating (corroborated by an official ¥5.00
  bonus); earliest expiry 2025-12-31". The earliest bonus `expiresAt` is appended only when the
  bonuses route confirms a grant.
- an external reduction: `检测到 ¥5.00 非消费性扣减（赠金过期回收等），未计入花费。` — "detected a
  ¥5.00 non-consumption deduction (e.g. a bonus expiry being reclaimed); not counted as spending".
  It is stated explicitly because the money left the balance without appearing in any counter.

## Parallel sessions and apportionment

The account balance is **account-level**: it does not say which session spent it, so the real cost
of one session is **not observable locally**. The plugin apportions it:

```text
session share = session accumulated spend × (session token cost / all sessions' token cost)
```

Token costs use the same four-class, peak/off-peak pricing for every session, so the weights are
comparable. With a single session the weight is exactly 1 and the value degrades to the exact
figure.

**This is an estimate.** Two sessions do not consume tokens in lockstep with the platform's
settlement, so the ratio drifts; when a new session joins the denominator the number steps down
once. The panel shows `Session share`, `Other sessions` and `Tracked sessions` so you can see what
the weight was.

## Persistence

Records live in `localStorage` under `dsh-balance-hud:tracker:v4`, keyed by session id:

```json
{ "sessions": { "<session id>": { "baseline": 43.42, "lastBalance": 43.12, "lastRead": 43.12, "spent": 0.3, "ts": 0 } } }
```

| Situation | Behaviour |
| --- | --- |
| Page refresh / remount | Read back from `localStorage`, counter keeps accumulating |
| Switching sessions | Each session has its own record; `checkoutSession` merges into it rather than rebuilding it, so `baseline`, `lastRead`, `lastBalance` and `spent` survive the switch |
| External change detected (top-up **or** reclaimed bonus) | Only the baseline moves; `spent` is untouched |
| Older than 30 days, or more than 30 sessions | Pruned on write; the 30 most recent records are kept |
| `localStorage` unavailable | Degrades to memory-only; the HUD still works |

The in-memory store also carries a `topups[]` history and a `lastObservedBalance` while the page
lives; the current writer persists **only** `sessions`. Within a record, `lastRead` is the
session-private "balance this session actually observed last" and is the preferred comparison point
on the next read; `lastBalance`, `baseline` and the shared `lastObservedBalance` are only fallbacks
for records migrated from older versions that predate `lastRead`. Old data is migrated automatically
— `v3` was `{ sessions: { … } }`, `v2` a flat `{ [sessionId]: { … } }` dictionary, `v1` a single
`{ sessionId, … }` record — and the legacy key is removed afterwards.

The balance is polled every **60 seconds** (every 5 minutes while the page is hidden) by default,
refetched immediately when the page becomes visible, and retried on failure with a 1s → 2s → 5s →
10s → 20s backoff. Not being logged in is not an error and does not trigger the fast retry. Both
intervals are configurable in the settings row (see [Settings](#settings)).

Two more keys exist alongside the accounting one, and they are **independent** of it:
`dsh-balance-hud:settings:v1` (the preference row, see [Settings](#settings)) and
`dsh-balance-hud:daily:v1` (the Beijing-day ledger, see [Budgets](#budgets)). Clearing or corrupting
one never affects the others.

## Architecture

```text
browser (client half, lib/client.js)          host (Host half, lib/index.js)
  registers the `shell.overlay` slot            inject: [deepseekAccount, webServer]
  polls every 60 s                              │
  fetch ──────────────────────────────────────► GET /api/balance-hud/balance   (read-only)
                                                GET /api/balance-hud/bonuses   (read-only)
                                                └─► ctx.deepseekAccount.getBalance()
                                                    ctx.deepseekAccount.getUnnotifiedBonuses()
                                                     └─► official account platform
```

**Why the relay exists.** The browser half cannot call `ctx.remote.account.getBalance` directly:
accessing it without declaring it throws
`cannot get property "remote.account" without inject`, and declaring `inject = ["remote"]` on the
client half cannot be satisfied — the fiber hangs forever and the plugin never activates. Both were
reproduced against real `@deepseek-ai/cordis` 4.0.4, so the Host half reads the balance and hands it
to the browser over a loopback-only, read-only route. Both routes accept **loopback sources only**
(`127.0.0.1`, `::1`, IPv4-mapped loopback forms) and answer `403` to anything else; they are
`GET`-only, never mutate state, never return credentials, and send `cache-control: no-store`.

| Payload | Meaning | HUD shows |
| --- | --- | --- |
| `{ kind: 'ready', currency, rechargeTotal, bonusTotal, total }` | Logged in, wallets available | `¥xx.xx` |
| `{ kind: 'unavailable', reason }` | Not logged in / credentials changed mid-query | not logged in |
| `{ kind: 'error', reason }` | Query failed, route unreachable, response malformed | read failed (reason in the panel) |

## Pricing

CNY per million tokens, from the official
[models & pricing](https://api-docs.deepseek.com/zh-cn/quick_start/pricing) page; off-peak is
exactly half of peak.

| Model | Cache hit | Cache miss | Output |
| --- | --- | --- | --- |
| `deepseek-flash` | off 0.02 / peak 0.04 | off 1 / peak 2 | off 4 / peak 8 |
| `deepseek-v4-pro` | off 0.15 / peak 0.30 | off 4.5 / peak 9 | off 13.5 / peak 27 |

- **Peak** = Beijing time Monday–Friday 09:00–12:00 and 14:00–18:00. Everything else (including
  weekends and public holidays) is off-peak; the conversion uses only the local weekday and hour,
  with no timezone library.
- **Cache writes** are billed at the cache-miss input rate.
- The price table holds both models; the **model is a setting** (default `deepseek-flash`), so the
  estimate and the apportionment weights follow your choice. Unknown models fall back to flash prices
  rather than to zero, and the panel says so. After an official price change, edit `PRICES` and
  refresh the page.

## Install

This is a local profile plugin; nothing is published to npm.

```powershell
node tools/install.mjs                     # install into ~/.dsh/profiles/desktop
node tools/install.mjs --dry-run           # preview, write nothing
node tools/install.mjs --uninstall         # remove it again
```

By hand, installing means placing the directory at
`~/.dsh/profiles/<profile>/plugins/dsh-balance-hud` (the client bundle is served from the profile,
so it must really live there), adding `"dsh-balance-hud": "file:./plugins/dsh-balance-hud"` to the
profile's `dependencies` plus `"dsh-balance-hud"` to its `dsh.profile.bundles`, linking it into the
profile's `node_modules` (a junction on Windows, a symlink elsewhere), and restarting DSH.

> **Gotcha:** the profile `package.json` must **not** have a UTF-8 BOM. With a BOM the plugin
> manager fails with `Unexpected token '\ufeff'`. `tools/install.mjs` rewrites the manifest without a
> BOM and keeps a `package.json.bak-balance-hud` backup.

Changing the **client** half (`lib/client.js`) needs only a page refresh. Changing the **Host**
half (`lib/index.js`, e.g. the bonuses route) needs a **DSH restart**, because profile bundles are
not hot-loaded.

## Development

```bash
node tools/smoke.mjs                      # offline smoke suite, no DSH install needed
node tools/verify-install.mjs --package   # packaging self-check, no DSH install needed
node tools/verify-install.mjs             # verify a real installation
```

`tools/smoke.mjs` evaluates the real `lib/client.js` against a fake React runtime, fake host
responses, a fake `localStorage` and a fake `document`, then drives the component through its hook
cycle. It prints one `✓` line per check (64 in total) and exits non-zero on the first failure,
covering module/slot registration, the card layout, hover and fold interaction, the balance
protocol and every route failure mode, pricing arithmetic, display precision, the external-change
classifier (top-ups **and** bonus expiry), persistence and the migration chain, and
visibility-driven refetch. The A1–A3 features have their own guards: the **two** slot registrations
(the overlay *and* the settings row), settings defaults, the field-by-field sanitising of dirty
config, the persistence round trip, container broadcast with partial merge and unsubscribe, the
corrupt-config fallback, the four budget levels with clamping, most-severe-of-two selection, the
daily ledger (accumulate / ignore 0 and negatives / cross-day reset / corrupt fallback), and the peak
countdown across peak, off-peak, lunch break and weekend. One persistence guard is the lossless round
trip: switching sessions through `checkoutSession` must leave `baseline` / `lastRead` / `lastBalance` /
`spent` untouched, and the persisted blob must contain no `undefined` field.

CI (`.github/workflows/ci.yml`) runs both offline scripts — `node tools/smoke.mjs` and
`node tools/verify-install.mjs --package` — on **ubuntu, windows and macos** with Node 20. Neither
script needs a DSH install, network access or a build step, so the matrix runs in clean containers and
proves that line endings (`.gitattributes` pins LF), path derivation and `import.meta` usage do not
depend on Windows.

It does **not** cover the Host half (`lib/index.js` is never loaded), a real browser, real Cordis
injection, or the real platform. `lib/client.js` is a hand-written CJS-style bundle in the official
`window.__ModuleLoader__.load({ id, factory })` format, so there is **no build step**.

| File | Role |
| --- | --- |
| `package.json` + `cordis.patch.yml` | Declare `dsh.bundle.patch` and `dsh.client` (`platform: web`, exports `./client`), and insert the plugin into the profile entry tree |
| `lib/index.js` | Host half: the two read-only loopback routes |
| `lib/client.js` | Browser half: the `shell.overlay` HUD, the `settings.general.item` row and all of the accounting |
| `tools/` | Installer, installation verifier, offline smoke suite |
| `.github/workflows/ci.yml` | Offline smoke suite + packaging self-check on ubuntu / windows / macos |
| `docs/DESIGN.md` | Contributor design note — the accounting model in full ([简体中文](docs/DESIGN.zh-CN.md)) |

## Privacy and security

- **The official API key is never touched by this plugin.** The Host half only calls `getBalance`
  and `getUnnotifiedBonuses`; it never calls `resolveToken` or `getPlatformSession`, so credentials
  stay inside `@deepseek-ai/dsh-deepseek-account-platform`.
- No secrets, tokens or account ids are stored in the repository, in `localStorage`, or in the HUD.
- The only network traffic the plugin adds is loopback HTTP to `/api/balance-hud/…`, which rejects
  non-loopback callers with `403` and returns balance numbers only. It sends nothing to a third
  party; the Host half's platform call goes through the account service DSH already uses.
- The bonuses route is read-only *and* non-acking, so it cannot swallow DSH's own bonus
  notifications.

## Limitations

- **The estimate covers model tokens only.** Any non-token billing item (plugins, retrieval, …)
  would make it too low.
- **Apportionment is an estimate**, and sessions whose usage projection is not reachable weigh 0 in
  the denominator, which can skew the share.
- **The platform settles with a delay.** Right after a run the actual figure may still sit at its
  old value while the estimate has already moved; the two converge over tens of seconds.
- **The first baseline is captured slightly after the session starts**, so earlier spending is
  covered by the token estimate instead.
- **A partial bonus expiry can still be misread as spending.** The token estimate is an upper bound,
  so if the reclaimed amount happens to fall within the estimate for that window the drop looks like
  ordinary spending. Eliminating that needs per-wallet expiry breakdowns, but `getBalance()` returns
  `AccountWallet` as `{ currency, balance }` only — **no expiry data** — so the error is bounded by
  the token estimate rather than removed. In the other direction, if the token estimate is
  unavailable and treated as `0`, the bound is tight and real spending in that interval could be
  misread as an external reduction; in practice the estimate is available because the usage
  projection is polled every 5 seconds.
- **The account-level figure is a reference only**, not a per-session number.
- **Not logged in** is a normal state: the card says so and the HUD recovers on the next poll after
  you sign in.

## License

MIT. See [LICENSE](LICENSE).
