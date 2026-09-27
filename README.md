**English** | [简体中文](README.zh-CN.md)

# dsh-balance-hud

An always-on HUD in the bottom-right corner of the **DSH (DeepSeek Harness)** Web GUI that shows your
DeepSeek **account balance** and the **cost of the current session**.

[简体中文说明](README.zh-CN.md) · [Design notes](docs/DESIGN.md) · [设计说明](docs/DESIGN.zh-CN.md) · [LICENSE](LICENSE)

- **Account balance** — recharge balance + bonus balance, read through the same service the
  *Settings → Account & balance* page uses (`ctx.deepseekAccount.getBalance()`).
- **Two cost figures** — a token-based *estimate* from the official price table, and an *actual*
  figure accumulated from real balance decreases.
- **Top-up aware** — a top-up raises the balance but never stops the spending counter.
- **Per session** — the tracker is keyed by session id; refreshing the page or switching sessions
  never clobbers another session's record.
- **No credentials, no outbound network of its own** — the plugin never touches your API key.
- **Two halves, one relay** — a browser half renders the HUD; a Host half exposes two read-only
  loopback HTTP routes so the browser can read the balance.

```bash
node tools/install.mjs    # install into ~/.dsh/profiles/desktop, then restart DSH
node tools/smoke.mjs      # offline smoke suite (47 assertions), no DSH install needed
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

## The two cost figures

| Figure | How it is computed | Nature |
| --- | --- | --- |
| **Estimate** | Session `tokenUsage` projection × the official price table | Exactly computable, but covers model tokens only |
| **Actual** | Accumulated sum of observed **balance decreases**, stored per session in `localStorage` | What the platform really charged, but settled with a delay |

The estimate splits usage into four token classes — uncached input, cache hit, cache write and
output — and prices each class with peak/off-peak rates. **Cache writes are charged at the
cache-miss rate**, matching how the platform bills them. The actual figure is a **counter, not a
subtraction**: every observed balance drop is added to the current session's counter, so a top-up
cannot disturb it.

## Top-up detection

**Principle: a top-up changes the balance but must not change the spending counter.**

The classifier uses a **token-estimate upper bound** instead of an arbitrary epsilon:

```text
balance rise > total token estimate + 0.02  →  the difference can only be externally added money
                                               (top-up, bonus grant, billing correction)
everything else                             →  ordinary spending, accumulate as usual
```

The platform can never have charged more than the tokens consumed are worth, so any bigger rise
must have come from outside. That survives a "top-up and spending at the same time" event and
cannot be triggered by normal spending noise. On detection the plugin only **re-anchors** the
baseline and leaves the counter untouched, so spending keeps accumulating — there is no "paused"
state. Because the balance is account-wide, a top-up re-anchors **every** session's baseline.

Three layers, in order of authority:

1. **The token-bound rule** — pure client side, always active, the authority.
2. **Official bonus-grant confirmation** — `GET /api/balance-hud/bonuses` reads
   `ctx.deepseekAccount.getUnnotifiedBonuses()`. It is **read-only and deliberately does not call
   `ackBonusNotified`**, so it never consumes DSH's own bonus notifications; the data stays
   readable and the client de-duplicates by `orderId`. If the route is unreachable the top-up is
   still detected — this layer is only corroboration.
3. **A manual fallback** — the *I just topped up* button takes the same re-anchor path and shows a
   "querying…" state while it re-anchors and queries the bonuses route.

A detected top-up shows a one-line notice in the panel for about 12 seconds.

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
{ "sessions": { "<session id>": { "baseline": 43.42, "lastBalance": 43.12, "spent": 0.3, "ts": 0 } } }
```

| Situation | Behaviour |
| --- | --- |
| Page refresh / remount | Read back from `localStorage`, counter keeps accumulating |
| Switching sessions | Each session has its own record; nothing is overwritten or reset |
| Top-up detected | Only the baseline moves; `spent` is untouched |
| Older than 30 days, or more than 30 sessions | Pruned on write; the 30 most recent records are kept |
| `localStorage` unavailable | Degrades to memory-only; the HUD still works |

The in-memory store also carries a `topups[]` history and a `lastObservedBalance` while the page
lives; the current writer persists **only** `sessions`. Old data is migrated automatically — `v3`
was `{ sessions: { … } }`, `v2` a flat `{ [sessionId]: { … } }` dictionary, `v1` a single
`{ sessionId, … }` record — and the legacy key is removed afterwards.

The balance is polled every **60 seconds** (every 5 minutes while the page is hidden), refetched
immediately when the page becomes visible, and retried on failure with a 1s → 2s → 5s → 10s → 20s
backoff. Not being logged in is not an error and does not trigger the fast retry.

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
- The model is currently pinned to `deepseek-flash` in the slot injection; `PRICES` in
  `lib/client.js` already contains both models. Unknown models fall back to flash prices rather than
  to zero, and the panel says so. After an official price change, edit `PRICES` and refresh the page.

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
cycle. It prints one `✓` line per check (47 in total) and exits non-zero on the first failure,
covering module/slot registration, the card layout, hover and fold interaction, the balance
protocol and every route failure mode, pricing arithmetic, display precision, the top-up classifier,
persistence and the migration chain, and visibility-driven refetch.

It does **not** cover the Host half (`lib/index.js` is never loaded), a real browser, real Cordis
injection, or the real platform. `lib/client.js` is a hand-written CJS-style bundle in the official
`window.__ModuleLoader__.load({ id, factory })` format, so there is **no build step**.

| File | Role |
| --- | --- |
| `package.json` + `cordis.patch.yml` | Declare `dsh.bundle.patch` and `dsh.client` (`platform: web`, exports `./client`), and insert the plugin into the profile entry tree |
| `lib/index.js` | Host half: the two read-only loopback routes |
| `lib/client.js` | Browser half: the `shell.overlay` HUD and all of the accounting |
| `tools/` | Installer, installation verifier, offline smoke suite |
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
- **The account-level figure is a reference only**, not a per-session number.
- **Not logged in** is a normal state: the card says so and the HUD recovers on the next poll after
  you sign in.

## License

MIT. See [LICENSE](LICENSE).
