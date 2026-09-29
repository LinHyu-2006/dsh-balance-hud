[English](DESIGN.md) | **简体中文**

# 设计说明：dsh-balance-hud

面向想改这个插件的贡献者。读完你应该能理解**为什么**记账是这样做的，以及哪些地方看起来
"绕了一圈"其实是被平台和数据形状逼出来的。

> 先读 [README.zh-CN.md](../README.zh-CN.md) 了解功能与安装。本文只讲设计与推导。

---

## 1. 前后各半，以及逼出这个结构的 Cordis 约束

插件有两个半边：

| 半边 | 文件 | 职责 |
| --- | --- | --- |
| 浏览器（客户端） | `lib/client.js` | 注册 `shell.overlay` 槽位、渲染 HUD、价格表解析、全部记账 |
| Host | `lib/index.js` | 注入 `deepseekAccount` + `webServer`，开只读回环路由（余额、赠金、可选的价格同步、模型列表） |

自然的写法是客户端半边直接调 `ctx.remote.account.getBalance()`。**这条路走不通**，
而且不是"没找对 API"，是两条硬性约束：

1. **不声明就访问** → Cordis 的依赖守卫抛
   `cannot get property "remote.account" without inject`。
2. **声明 `inject = ["remote"]`** → 这个服务在客户端侧无法满足，
   **fiber 永久挂起**，插件的 `apply` 根本不会跑完，HUD 完全不出现。

两条都在真实 `@deepseek-ai/cordis` 4.0.4 上复现过。客户端半边能注入的服务只有
`slots` 和 `sessions`（见 `exports.inject`）。

于是变成 Host 中继：

```text
浏览器 ──fetch──► GET /api/balance-hud/balance    （只读、仅回环）
                  GET /api/balance-hud/bonuses    （只读、仅回环、不回执）
                  GET /api/balance-hud/…          （价格同步：需主动开启；模型列表：仅回环）
                  │
                  └─► ctx.deepseekAccount.getBalance()
                      ctx.deepseekAccount.getUnnotifiedBonuses()
                      └─► 官方 @deepseek-ai/dsh-deepseek-account-platform
                      fetch(PRICING_DOC_URL)  ← 仅用户主动开启同步时
                      └─► 官方价格文档页
```

**安全边界**：所有路由都只认回环来源（`127.0.0.1`、`::1`、`::ffff:127.0.0.1`、`127.*`），
其它一律 `403`；只支持 `GET`；不改任何状态；不带凭据；响应带 `cache-control: no-store`。
**唯一的对外目的地**是可选的价格同步 —— 只有它会请求非回环主机（`PRICING_DOC_URL`，见 §7）；
模型列表来自 DSH 自己的 `llm` 服务，同样只需要回环。
涉及账号数据时，Host 半边**从不需要取 token** —— 它只调 `getBalance` / `getUnnotifiedBonuses`，
从不调 `resolveToken` 或 `getPlatformSession`，所以凭据始终留在官方包里。

---

## 2. 余额记账模型

### 2.1 三个量

每个会话在 `localStorage` 里存一条记录：

| 字段 | 含义 |
| --- | --- |
| `baseline` | 该会话**第一次被看到时**的账户余额（锚点） |
| `lastBalance` | 最近一次读到的余额（用于算本次降幅） |
| `spent` | **累计花费计数器** —— 只由"余额下降"累加 |

外加两个全局的量：`lastObservedBalance`（最近一次读数，可能来自别的会话，
因为账户余额是共享的）和 `topups[]`（充值事件历史）。

卡片上的 `实际扣费` 就是 `spent`（并行会话时再按比例分摊，见 §3）。

### 2.2 一次读数怎么记账：`classifyRead` + `observeRead`

`classifyRead(previousBalance, balance, tokenEstimate)` 是纯函数，只返回判定：

```
|升幅| ≤ 0.0001                       → noise（忽略）
余额下降                              → spend（降幅计入 Counter）
余额上升 > tokenEstimate + 0.02        → topup
余额上升但没超过上界                   → noise（忽略）
```

`observeRead(sessionId, balance, tokenEstimate)` 是唯一入口：读表 → 判定 → 落盘 →
返回 `{ kind, amount, spent, store }`。两个关键细节：

- **判定用本会话自己的上次读数**：`previousBalanceOf` 首选 `lastRead`（本会话真正观测到的余额）。
  这是刻意的 —— 外部变动会改写 `baseline` / `lastBalance`，但不会动 `lastRead`，
  于是别的会话观测到的变动会在本会话下次读数时重新出现，被各自独立判出（§2.4）。
  只有迁移过来的老数据才回退到 `lastBalance` / `baseline` / 共享的 `lastObservedBalance`。
- **外部变动走 `applyExternalChange`**：把所有会话的 `baseline` 与 `lastBalance` 一起移到
  当前余额（**不动 `lastRead`**），**`spent` 全部原样保留**，并在 `topups[]` 里记一条
  （带 `kind`：`topup` 或 `expire`）。

### 2.3 为什么最终选了计数器，而不是"锚点相减"

这是整个插件改得最久的一处，值得记下来。

**第一版**：`实际花费 = baseline − 当前余额`。简单，而且单会话下完全正确。
问题是充值：余额一旦升高，这个式子会变成 0（被 `Math.max(0, …)` 夹住），
界面显示"充值后暂停"，**整个花费读数停摆**，要等消费重新跌回旧锚点才恢复。
用户明确不接受这个行为。

**第二版（错的）**：改用**所有会话锚点之和**当账户级锚点：

```
账户级 = Σ(各会话 baseline) − 当前余额
```

当时以为"后开的会话锚点已经扣掉了前面那段，求和正好抵消重叠"。**这是错的**：
`Σ baseline` 会把重叠部分重复计入。具体地，A 锚点 50、余额降到 49.2 时 B 才首见
（B 的锚点就是 49.2），求和得 99.2，减当前余额 49.2 得 50 —— 而真实只花了 0.8。
错了一个数量级。

**第三版**：改成"**最早**锚点 − 当前余额"。方向对了，但踩了一个更隐蔽的坑：
余额随消耗**单调下降**，所以"最早的锚点"是数值**最大**的那个，
应该用 `Math.max`。当时写的是 `Math.min`，拿到的是**最后开的会话**的锚点，方向正好反了。
这个 bug 因为 `Math.min([50, 49.2])` 在中文思维里"最小值"和"最早"容易混，靠读代码很难看出来，
最后是用一个只有几行的独立最小复现脚本跑出来的。

**第四版（当前）**：计数器模型。`spent` 只增不减：

```
余额下降 → spent += 降幅
识别充值 → 只抬锚点，spent 不动
```

好处是充值从"需要特殊处理的事件"变成"一次无副作用的重锚"，不再需要暂停、
也不需要恢复判定，代码路径只有一条。这也是用户最初要求的语义：
**不改变花费，只改变余额。**

### 2.4 外部变动判定为什么要用 token 估算上界（双向）

一开始用的是固定 epsilon（`余额升幅 > 0.01` 就是充值）。这个数没有依据，
而且两头都错：平台余额偶尔向上抖动 0.01 会误判；"充值和消费同时发生"时
又可能因为净升幅很小而漏判。

**上界判据**：

> 平台扣掉的钱**不可能超过**这段时间消耗的 token 按官方价目表算出来的钱。

这句话**双向都成立**。上升方向：任何超过 token 估算的升幅**必然**来自外部
（充值 / 赠金到账 / 账单修正）。下降方向：任何超过 token 估算的降幅**也必然**来自外部
（赠金过期回收 / 退款 / 账单修正）—— 因为真实消费不可能超过 token 所值的钱。

```
升幅 > 上界 + 0.02  →  topup   外部加钱
降幅 > 上界 + 0.02  →  expire  外部减钱
其余                →  spend / noise
```

容差只需要覆盖浮点和分位取整噪声，所以 `TOPUP_TOLERANCE = 0.02` 就够了。

**`expire` 这一档是赠金时效性逼出来的。** 赠金有有效期，到期未用完的部分被平台回收，
表现是余额凭空下降却没有对应消费。早期实现里 `classifyRead` 有一行

```js
if (delta < 0) return { kind: "spend", amount: -delta };   // ❌ 任何下降都算消费
```

于是 5 元赠金过期被记成 5 元花费；又因为 `spent` 只增不减，这个错误会留在记录里
直到 30 天后被淘汰。现在 `topup` 与 `expire` 走**同一条路径**：
`applyExternalChange` 只移动账户级字段，`spent` 原样保留，并在 `topups[]` 里记下 `kind`。

**一个关键的不变量**：`applyExternalChange` 移动所有会话的 `baseline` / `lastBalance`，
但**绝不动 `lastRead`**。理由见 `previousBalanceOf`：`lastRead` 是会话私有的
"上次真正观测到的余额"，不动它，每个会话就会**自愈** —— 还没观测到这次变动的会话
下次读数时仍能看到完整落差，于是自己也能判出这是外部变动，而不会把差额摊到消费上。

### 2.5 三层保障

| 层 | 实现 | 权威度 |
| --- | --- | --- |
| 1 | token 上界判据（纯客户端、双向） | 权威 |
| 2 | 官方赠金印证 `GET /api/balance-hud/bonuses` | 印证（只覆盖"发放"） |
| 3 | 手动兜底按钮 | 纠正 |

第 2 层有个**刻意的设计决定**：`getUnnotifiedBonuses()` 拿到的是"未回执"的赠金，
官方还提供了 `ackBonusNotified()` 来回执。插件**只读不回执** ——
回执会把赠金标成"已展示"，那会**抢掉 DSH 自己的赠金通知**。
代价是这份数据会一直可读，所以客户端按 `orderId` 去重。
如果这条路由不通，变动**仍然会被识别**（第 1 层是权威），这一层只是加分。

还要注意第 2 层的**能力边界**：它只能印证"赠金发放"，**官方没有"过期"的推送**。
所以减钱那个方向完全依赖第 1 层。官方在赠金条目里给了 `expiresAt`，
插件把它透出来显示"最早到期"，但**不参与记账判定** —— 判定唯一的依据是 token 上界。

第 3 层不只是视觉反馈：它先做重锚（本地、瞬时），**再**查一次赠金路由（网络），
`查询中…` 这个状态就是由那次真实网络请求支撑的。

---

## 3. 分摊，以及它为什么只是估算

账户余额是**账户级**的，它不携带"这笔钱是哪个会话花的"。所以单个会话的真实花费
**在本地不可观测** —— 这不是实现偷懒，是信息本身不存在。

插件用 token 成本当权重分摊：

```text
本会话分摊 = 本会话累计花费 × (本会话 token 成本 / 全部会话 token 成本)
```

权重必须**可比**：所有会话都用同一套四类计价（未命中输入 / 缓存命中 / 缓存写 / 输出）
和同一个峰谷档，否则一个 pro 会话和一个 flash 会话的权重不可比。
只有一个会话时权重恒为 1，结果退化成精确值。

**为什么它是估算**：两个会话的 token 消耗与平台结算不同步；新会话加入会让分母突然变大，
数字下跳一次；拿不到用量投影的会话在分母里权重为 0，会让占比失真。
面板里给出 `本会话占比` / `其它会话` / `跟踪会话` 就是为了让这个权重**可见**，
出问题时能一眼判断是"分母没算进去"还是"比例算错了"。

---

## 4. 设置、预算与峰时提醒

### 4.1 两个注册点，没有共同的 React 祖先

插件注册了**两个**互相独立的槽位：

| 槽位 | id | 组件 |
| --- | --- | --- |
| `shell.overlay` | `balance-hud` | `BalanceHud` —— 钉在右下角的浮层 |
| `settings.general.item` | `balance-hud-settings` | `BalanceHudSettingsRow` —— 设置里的那一行偏好 |

`settings.general.item` 是 DSH 官方定义的座位：「General 区里的一行偏好 —— 单个设置专用的增量
座位，不需要独占一整页（要整页请用 `settings.section`）」。DSH 自己的 Language、link-opening、
performance-usage 几行也注册在这里。插件选"一行"而不是"一页"是刻意的：它只有一组设置，
不该占一个设置页，而这个槽位本来就是增量式的。

两个注册点渲染在**树的不同位置，没有共同的 React 祖先**，因此无法共享 React state。
它们改用一个小的订阅容器 —— `createSettingsStore()` 返回 `{ get, set, subscribe }`：

```text
set(patch) → normalize({ ...current, ...patch }) → 落盘 → 广播给所有订阅者
```

所以 `set` 会**合并一份部分补丁**（设置行只发它改的那一个字段），再把合并结果广播出去；
在任一处改，另一处立刻看到同一份对象。`useSettings(store, useState, useEffect)` 是 React 绑定：
用 `store.get()` 做初值并订阅。这就是两个组件互不依赖的原因 —— 谁先渲染都行，没有任何顺序要求。

### 4.2 边界处收敛：`normalizeSettings`

配置存在 `localStorage` 的 `dsh-balance-hud:settings:v1`，这个键**刻意**与记账键
`dsh-balance-hud:tracker:v4` 分开，两者不可能互相干扰。从这个键读到的内容一律是
**不可信输入**：用户可以手改，旧版本也可能留下已经不存在的字段。

`normalizeSettings(raw)` 因此**逐字段对白名单校验**，并返回一个全新对象；`loadSettings()` 把
`JSON.parse` 包在 `try/catch` 里，所以 JSON 损坏时回落到 `defaultSettings()` 而不是抛错：

| 字段 | 规则 | 违规时 |
| --- | --- | --- |
| `model` | 必须在 `MODEL_CHOICES` 里 | 回落 `deepseek-flash` |
| `pollSeconds` / `hiddenPollSeconds` | 必须在 `POLL_CHOICES`（30/60/120/300）里 | 回落 60 / 300 |
| `showAccountTotal` / `notifyBudget` / `notifyPeak` | 必须是真正的布尔 | 回落默认 |
| `sessionBudget` | 有限数字，0–100000 | 回落 0（不设） |
| `dailyBudget` | 有限数字，0–1000000 | 回落 0（不设） |
| `peakWarnMinutes` | 必须在 `PEAK_WARN_CHOICES`（5/10/15/30）里 | 回落 10 |

这条规则可以推广：**凡是用户可写、且随版本变化的数据，每次读取都必须重新校验，永不信任。**
脏值绝不能把 HUD 弄崩，也绝不能流进价格表。

### 4.3 预算模型：为什么是描边，而不是多一格

```text
evaluateBudget(spent, budget) → { level, ratio, remaining }
  budget <= 0 或 spent 不是数字 → { level: 'none', ratio: 0, remaining: undefined }
  ratio >= 1.00 → 'over'    ratio >= 0.90 → 'critical'    ratio >= 0.75 → 'warn'    否则 'none'
  remaining = max(0, budget − spent)
worstBudgetLevel([本会话, 每日]) → 取更严重的一条
```

`BUDGET_STEPS` 从高到低匹配，所以 1.2 的比率是 `over` 而不是 `warn`。`remaining` 夹在 0 以上 ——
"剩余 -3 元"不是有用的信息。卡片的颜色取自 `worstBudgetLevel`，而不是只看本会话预算：
今天已经用爆、本会话还很便宜时，照样告警。

**视觉上是 3 px 的彩色左边框，刻意不是网格里的第五格。** 卡片是两列网格，行只有
`账户余额` / `本会话预估`，而冒烟测试断言"恰好 4 格 + 这两个标签"。为了一个瞬时状态把网格撑大
会破坏这个对齐契约 —— 用强调色表达更合适。描边用现成的主题变量
（warn / critical 用 `--dsw-alias-label-warning`，over 用 `--dsw-alias-label-error`），
并用 `paddingLeft` 补偿，所以它出现时文字不会位移。

系统通知这条路是**可选且有界的**：`notifyBudget` 默认 `false`，发送需要
`Notification.permission === 'granted'`，并用一个 `Set` 保证**每个档位在本次挂载内最多一条**。
预算超限持续一小时也只通知一次，而不是每次轮询都弹；没有权限时静默降级为只有描边。

### 4.4 每日台账：北京自然日 + 只吃确认花费

键 `dsh-balance-hud:daily:v1`，形状 `{ date, total }`：

```text
beijingDateKey(now)   → 北京自然日的 'YYYY-MM-DD'（UTC+8，不引时区库）
loadDaily()           → 存的日期 ≠ 今天：写回 { today, 0 } 并返回 0
addDailySpent(amount) → amount > 0 ? total + amount : 不变
```

两个决定值得记下来：

- **用北京日，不用本地日。** 官方计价档位与计费窗口都按北京时间，日预算的日界必须同一个口径。
  按本地午夜归零，对大多数用户来说会在北京峰时段的中间翻篇。
- **只吃确认花费。** `addDailySpent` 只有一个调用点：余额 effect 里
  `verdict.kind === 'spend' && verdict.amount > 0` 的分支 —— 也就是某次真实余额读数**确认**为消费的
  金额。它绝不接受卡片上那个递推显示值 `ownEstimate`：那个值在两次读数之间平滑增长，
  每次滴答都会把同一笔钱再加一遍。非正数一律忽略，所以充值或 `expire` 不可能给当天做加减。

因为 `loadDaily` 在日期不同时会重写记录，第二天早上打开 HUD 就是从 0 开始，不需要任何重置任务。
台账只有一条记录、不是历史 —— 只有"今天"对日预算有意义。

### 4.5 峰谷倒计时的算法

`minutesUntilTierChange(now)` 返回 `{ minutes, to }`，`to` 为 `'peak'`（下一次切换进入峰时）
或 `'off'`（下一次切换回到闲时）。峰时是北京时间**周一至周五 09:00–12:00 与 14:00–18:00**；
`PRICES` 里峰时价恰好是闲时的 **2 倍**，所以这个倒计时是实打实的省钱信息。

所有换算走 `beijingClock(now) → { minutes, day }`（北京当天分钟数 + 星期），分支是：

| 情况 | 结果 | `to` |
| --- | --- | --- |
| 工作日 09:00 前 | 09:00 − now | `peak` |
| 09:00–12:00 | 12:00 − now | `off` |
| 12:00–14:00（午休） | 14:00 − now | `peak` |
| 14:00–18:00 | 18:00 − now | `off` |
| 工作日 18:00 后 | 绕到次日 09:00 | `peak` |
| 周六 | 到周一 09:00（2 天） | `peak` |
| 周日 | 到周一 09:00（1 天） | `peak` |

几个例子（冒烟测试全都钉住了）：周五 18:30 → 周一 09:00 是 `24*60 − 1110 + 540` = **870 分钟**；
周六 12:00 → 周一 09:00 是 **2700 分钟**（45 小时）；周一 09:30 → 12:00 是 **150 分钟**（`off`）；
周一 17:50 → 18:00 是 **10 分钟**（`off`）。

> **为什么周末要单独一个分支。** 工作日只要在 `PEAK_WINDOWS` 里找"开始时间大于当前分钟"的那一段
> 就够了；周末当天根本没有时段，所以代码显式跳到周一 09:00（`day === 6 ? 2 : 1` 天，减去当前
> 分钟偏移，再加 540）。这里写错的话周一到周五完全看不出来，一到周末就全错。

一个固定的 **60 秒滴答**（`setInterval(…, 60000)`）递增时钟 state 并重读 `loadDaily()`，
因此倒计时与跨天重置都是活的，不需要额外的调度逻辑。面板只在 `notifyPeak` 打开、且下一次切换
落在 `peakWarnMinutes` 以内时显示提醒：`to === 'peak'` 显示
`约 N 分钟后进入峰时，价格翻倍`，`to === 'off'` 显示 `约 N 分钟后回到闲时价`。

---

## 5. 持久化：结构、迁移、淘汰

键：`dsh-balance-hud:tracker:v4`

```json
{
  "sessions": {
    "<会话id>": { "baseline": 43.42, "lastBalance": 43.12, "lastRead": 43.12, "spent": 0.3, "ts": 0 }
  }
}
```

字段语义（三者的区别容易被混，务必分清）：

| 字段 | 含义 | 谁在改 |
| --- | --- | --- |
| `baseline` | 本会话窗口**起点**的账户余额 | 外部变动时被重锚 |
| `lastBalance` | 最近一次**外部变动后**的账户余额（账户级） | 外部变动时被重写 |
| `lastRead` | 本会话**真正观测到**的余额 | **只有本会话自己的读数会改它** |

`lastRead` 是唯一不该被外部变动触碰的字段 —— 这正是每个会话能"自愈"的原因（§2.4）。

> 目前 `writeStore()` **只持久化 `sessions`**。`topups[]` 与 `lastObservedBalance`
> 只活在内存里（页面存活期间）。这是已知的取舍，不是 bug —— 它们不参与跨会话的正确性。

**迁移链**（`readStore` 里读到旧键就转换，然后删掉旧键）：

| 版本 | 旧形状 | 处理 |
| --- | --- | --- |
| `v3` | `{ sessions: {…} }` | 直接取 `sessions`，顺手删掉废弃的 `start` 字段 |
| `v2` | `{ [会话id]: {…} }` 扁平字典 | 过滤出有 `ts` 的条目 |
| `v1` | `{ sessionId, baseline, start, ts }` 单条 | 包成一条记录 |

**淘汰规则**（在 `writeStore` 里）：

- 单条记录 `ts` 超过 **30 天** → 丢弃
- 超过 **30 个会话** → 按 `ts` 保留最近 30 个

**轮询节奏**：`BALANCE_POLL_MS = 60000`，页面隐藏时 `BALANCE_POLL_HIDDEN_MS = 300000`，
`visibilitychange` 回到前台立刻补读；失败按 `1s → 2s → 5s → 10s → 20s` 退避
（`BALANCE_RETRY_MS`），未登录不算错误、不进快退避。

---

## 6. 踩过的坑

按"下次最容易再踩"排序。

**6.1 共享状态用普通对象 → 不会触发重渲染。**
`baselineStage.store` 是个普通 JS 对象（跨闭包共享），改它 React 不会重渲染。
而"哪些会话参与分摊"正是渲染时读 store 得到的。结果：切到新会话后分母没更新 →
占比恒为 100% → **每个会话显示同一个数**。修法是加一个 `epoch` 版本号 state，
store 一变就 `bumpEpoch()`。

**6.2 `Math.min` / `Math.max` 的方向，在中文语义下极易混。**
"最早的锚点"因为余额单调下降而等于数值**最大**的锚点。
`Math.min([50, 49.2])` 用中文念"最小值"时，和"最早"在脑子里是同一个位置。
写代码时一定要把物理含义（"余额越早越高"）写进注释，
单锚点用例还会掩盖这个 bug（`Math.min([50]) === Math.max([50])`）。

**6.3 同一份口径写两遍 → 迟早漂移。**
曾经既在渲染路径里算分摊、又注入一个 `apportionedDelta` 函数在别处算，
两份实现一旦有一处改动就会出现"代码里是 A、界面跑的是 B"。
现在只保留渲染路径一份，注入的重复实现已删除。**加新功能时不要复制口径。**

**6.4 测试框架的 `useRef` 替身忽略了初值。**
替身写成 `{ current: null }`，而真实 React 会执行 `useRef(initialValue)`。
在组件开始依赖 `useRef({...})` 的初值之前，这个差异一直潜伏；
一旦依赖就崩。替身必须尊重初值，否则测试环境与真实运行时行为不一致。

**6.5 测试跑得比真实环境快，会观察不到中间态。**
`查询中…` 这类中间状态在 mock 里因为 fetch 立即返回而被同一批微任务收尾，
根本观察不到。用**挂起**的请求（`bonusMode = 'hang'`）才能稳定断言。
要注意区分：这是测试太快，不是功能缺失。

**6.6 原生 `title` 属性会毁掉 HUD。**
悬停约一秒后浏览器弹出不透明黑框，正好盖住面板。全插件**不得有** `title`，
摘要写在 `aria-label` 里，并由冒烟测试当回归守卫断言。

**6.7 悬停判定不能挂在容器盒子上。**
容器在四周预留了空白（8px 间隔 + 布局余量），挂容器上会让面板停在
"其实已经离开卡片"的空白处不消失。判定必须挂在卡片和面板**各自**身上，
并配一个 140ms 的待关闭定时器，让指针穿过 8px 间隔时面板的 enter 取消卡片的 leave。

**6.8 持久化层曾经是"有损"的 —— 两个写入方都漏字段。**
第一处：`createTracker` 把磁盘字段 `lastBalance` 改名成 `last`，并且只映射了当时存在的几个字段。
后来给记录加了 `lastRead`，`readStore()` 能读到、但 `observeRead` 拿到的对象里没有它，
于是 `previousBalanceOf` 退化成用**事件余额**当上次读数，把整段真实消费判成外部变动**吞掉**。
第二处：`persistTracker` 用固定字段列表**重建**整条记录，于是 `checkoutSession`
（每次切换会话都会走）会把 `lastRead` 抹掉，还会把 `lastBalance` 写成 `undefined`
—— 而 `undefined` 在 `JSON.stringify` 时会**直接消失**，等于静默删字段。
教训：持久化记录在"读—改—写"之间必须**无损**；写入方要以磁盘上已有的那条为基底，
只覆盖自己确实持有的字段。现在两个写入方都遵守这条，并各有一个回归断言钉着。

**6.9 一个字段塞两种含义，必然出错。**
修 6.8 的过程中我加过一个"重锚桥"字段 `reanchor`，想让它在外部变动后
充当"上次读数"。问题是它同时被当成"变动前的余额"和"上次读数"用，
于是每次修一个方向就从另一个方向漏水，来回改了四五轮。
最后把它整个删掉，只留 `lastRead` 一个字段承载一种含义，代码立刻变简单且正确。
**当某个字段需要在一段注释里解释两种用途时，就该拆成两个字段。**

---

## 7. 价格同步：可选、与编码无关、自证校验

预估用的价格表过去是一个常量，只有改源码才会变。现在它可以**从官方价格页同步**，这条链路上的每个
决定都由三个约束塑造：插件「不自己联网」的承诺、页面的编码，以及「错价比旧价更糟」这一事实。

### 7.1 抓取为什么放在 Host 半边

`PRICING_DOC_URL` 是 `https://api-docs.deepseek.com/zh-cn/quick_start/pricing`，
也是插件唯一会访问的外部主机。浏览器半边从不直接访问它：客户端调 `syncPrices()` 走回环路由
`PRICING_ROUTE`（`/api/balance-hud/pricing`），调 `MODELS_ROUTE`（`/api/balance-hud/models`）
列模型，由 Host 半边执行 `fetch`。Host 侧还写死 `PRICING_HOST = 'api-docs.deepseek.com'` 并自己
拼 URL —— 这条路由只接受条件请求校验值，**不接受调用方传 URL**，因此不可能被当成任意 URL 代理。

三个理由，按重要性排序：

1. **前后半边的形状本来就是这样。** §1 的中继之所以在 Host 侧，是因为客户端半边够不到账号服务；
   任何对外请求都受同一个不对称性约束。把唯一的网络目的地留在 `lib/index.js` 里，
   「这个插件能访问哪里」就只有一页答案，评审时看得完。
2. **没有 CORS，也没有浏览器策略面。** 从客户端半边发跨源 `fetch` 会依赖文档站的 CORS 头，
   而且请求跑在用户的浏览器会话里（cookie、origin、referrer）。Host 半边的 Node 侧 `fetch`
   就是一个普通的服务端请求，这些都不存在。
3. **模型列表根本不需要网络。** DSH 自己的 `llm` 服务本来就暴露了已注册的模型与 provider
   （`listProviders()` / `listModels(id)`），所以「哪些模型有价」是一次纯回环读取。
   `llm` 是可选依赖：拿不到时路由返回空目录，客户端回落到内置的模型选项。

条件请求被拆在两侧：客户端把缓存里的 `etag` / `lastModified` 作为**查询参数**交给回环路由
（这是回环持有者自己的数据，而且让路由保持成一个普通 `GET`），Host 再把它变成发出请求上的
`If-None-Match` / `If-Modified-Since` 头。页面没改就回 **`304 Not Modified` 且没有响应体** ——
每次轮询只有几百字节 —— 此时 `syncPrices()` 只刷新缓存里的 `checkedAt` 时间，不替换价格表。

### 7.2 编码陷阱，以及为什么每个判断都与编码无关

抓取链路可能把 UTF-8 字节按 Latin-1 解开。这时 `元` 会变成两个乱码码点，长度还随解码方式变化，
页面上所有中文标签（`空闲时段`、`高峰时段`、`百万tokens输入`）都成了乱码。
**任何依赖这些标签的判断，都能在手工保存的页面上跑通，却在真实抓取链路上失效。**

所以 `parsePricingPage` 里没有任何中文匹配。它只用三个锚点，全部与编码无关：

| 判断 | 锚点 | 为什么换编码也成立 |
| --- | --- | --- |
| 有哪些模型、分别是哪一列 | 表头行里的模型 id（`deepseek-…`） | id 是 ASCII，只需要位置 |
| 这一格是不是价格 | 「以数字开头，后面除了空白与非数字字符什么都没有」 | `元`、乱码、空后缀都能命中；含字母的说明格（如 `百万tokens输入`）会被排除 |
| 这一行是哪一档 | 区段内的**行序**（每类第一行闲时、第二行峰时） | 官方表格排版固定，不需要查标签 |

脚本、样式和注释块会先被剥掉，因为里面也有数字。

### 7.3 语义自证比「解析完整」更重要

官方规则是「闲时价 = 峰时价的一半」，所以每个模型的每个类别都必须**严格**满足 `peak > off`；
校验还要求两档都存在、有限且非负。

这比「解析完整」重要得多。漏掉一行的解析会留下一个洞，看得见；**取错六行**的解析一个洞都没有 ——
它给出的是**挂在错误档位上的、看起来完全合理的数字**，而这些数字会直接进入预估与分摊权重。
拿官方规则去校验的关系式，正好能抓住这类错误，而形状/数字检查抓不住。

校验一旦不过，整次同步**整体作废**：插件保留上一份好表（内置表，或上次同步成功的表），
**绝不拿半份结果去算钱**。这也是为什么回落点是 `resolvePrices`，而不是「拿到多少算多少」。

### 7.4 两个噪声行，以及价格区段是怎么定位的

真实页面上，恰好在一个「顺手扫一遍」会捞到的位置，有两行看起来就像价格：

- 表头里的上下文长度行（`上下文长度 | 1M`）；
- 紧跟在价格区段后面的并发限制行（`并发限制 | 2500 | 500`）。

后者更麻烦：它让价格区段变成**七**行，于是「价格表头后面取连续六行」会滑到它上面。
所以解析器不信固定偏移：它先按 §7.2 的编码无关判据收集所有候选行，再枚举它们的**连续六行**组合，
取第一个通过 §7.3 语义校验的组合。混进任一噪声行的组合都会让 `peak > off` 失败，
于是换下一个起点重试。

### 7.5 缓存键与来源标识

`savePriceCache` / `loadPriceCache` 用的 `localStorage` 键是
`dsh-balance-hud:prices:v1`（`PRICES_CACHE_KEY`），里面是
`{ models, capturedAt, checkedAt, etag, lastModified, source }` —— 解析出的价格表，
**外加 HTTP 校验器与时间戳**。校验器正是让下一次轮询变成 304、而不是整页重传的东西；
`checkedAt`（上次检查时间）与 `capturedAt`（价格表真正抓取的时间）刻意分开保存。
读取和其他存储访问一样包在 `try/catch` 里，缓存损坏就退回内置表。

`resolvePrices(priceCache)` 做合并：同步来的模型**按模型**优先，同步没覆盖到的内置模型保留下来，
所以官方新增或下架模型都不会把表弄空。它返回
`{ prices, source: 'synced' | 'builtin', capturedAt }`，设置行把来源和日期渲染出来 ——
`当前价格：内置表（2026-09-29）`（`BUILTIN_PRICES_DATE`）或 `当前价格：已同步（YYYY-MM-DD）`。
把过期价格悄悄标成当前价格，正是这套来源标识要防的事故。

### 7.6 为什么默认是关

插件的隐私承诺是「不自己增加网络流量」，而余额 HUD 也不是那种「装上就会去连外部主机」的组件。
所以出厂状态是 `off`：`defaultSettings()` 里 `syncHours: 0`，间隔 effect 在 `hours <= 0` 时直接
返回，`normalizeSettings` 用 `SYNC_INTERVAL_HOURS = [0, 6, 24, 72, 168]`
（`off` / 6 小时 / 24 小时 / 3 天 / 7 天）逐字段白名单校验。用户不按 **`同步价格`**、
也不主动选间隔之前，什么都不会抓。`DEFAULT_SYNC_HOURS = 24` 记录的是开启自动同步后应该用的节奏：
changelog 会先预告调价、价格页之后才改，这是「几个月一次」的事件，而 304 让每天一次的轮询几乎不花
成本。默认关还有一个好处：离线冒烟套件里没有任何路径能悄悄开始依赖网络。

---

## 8. 测试策略

```bash
node tools/smoke.mjs                      # 离线，71 条断言，不需要装 DSH
node tools/verify-install.mjs --package   # 打包自检（清单 / patch / 两份入口）
node tools/verify-install.mjs             # 校验真实安装
```

`tools/smoke.mjs` 的做法：把真实的 `lib/client.js` 求值一遍（模拟
`window.__ModuleLoader__.load`），再用手写的最小 React 运行器驱动组件走完 hook 周期。
它带假的 React、假 fetch、假 `localStorage`、假 `document`，
**完全离线**，不依赖 DSH 安装。

**它覆盖**：模块/槽位注册形状（**两个**注册点）、卡片两列网格、悬停与折叠交互（含跨间隔、左侧滑出）、
余额三态与全部路由失败模式、四类计价与峰谷、显示精度与 `<¥0.01` 哨兵、
充值**与过期**两类外部变动判据、持久化与 v1→v4 迁移链、可见性补读，以及设置（默认值 /
脏配置收敛 / 落盘往返 / 容器广播与部分合并 / 损坏回落）、预算四档与剩余夹 0、两条预算取最严重、
每日台账（累加 / 忽略 0 与负数 / 跨天归零 / 损坏回落）、峰谷倒计时（峰时 / 闲时 / 午休 / 跨周末）。

**它不覆盖**：Host 半边（`lib/index.js` 从不加载，因此可选的价格同步抓取、
`If-None-Match`/304 路径与模型列表路由都没有离线测试）、真实浏览器、真实 Cordis 注入、
真实平台。所以**改了 Host 半边必须手工验证并重启 DSH**。

**作为回归守卫写死的断言**（改坏了会立刻红）：

- 不得出现 `title` 属性
- 卡片是两列网格，且**只剩 2 行**（`账户余额` / `本会话预估`）
- 充值**不得**改变 `spent`
- **赠金过期（外部减钱）不得改变 `spent`**，且锚点要同步下移
- 降幅在 token 上界以内**仍须算消费**（不能把正常消费误判成回收）
- 过期要把所有会话的锚点一起下移，而各会话**仍按自己的上次读数**继续累计
- 两个会话的分摊值**必须不同**（防锚点串号）
- **切换会话不得损坏记录**：`checkoutSession` 之后 `baseline` / `lastRead` / `lastBalance` /
  `spent` 必须一字不变，且持久化内容里不得出现 `undefined`
- `tokensOf` 与 `costOf` 口径一致，且峰时价 > 闲时价
- `查询中…` 状态出现且按钮 disabled，并且确实调用了赠金路由
- **槽位注册恰好两个** —— `shell.overlay`（id `balance-hud`）与 `settings.general.item`
  （id `balance-hud-settings`）；浮层的槽位名与 id 被校验，设置行至少断言"确实注册了"
  （新注册点必须同步改这条，见 CONTRIBUTING）
- **设置**：默认值（flash / 60 秒 / 不设预算）、脏配置逐字段收敛而合法值不动、落盘往返、
  容器广播 + 部分合并 + 取消订阅、配置损坏回落默认且不抛错（§4.2 的边界规则）
- **预算**：75% → `warn`、90% → `critical`、≥100% → `over`、`remaining` 夹到 0，
  且两条预算取最严重的一条（§4.3）
- **每日台账**：累加确认花费、忽略 0 与负数、北京日期变化时归零、内容损坏回落 0（§4.4）
- **峰谷倒计时**：峰前、峰后、跨午休，以及周五 18:30 → 周一 09:00（§4.5 的跨夜与跨周末分支 ——
  这里写错的话周一到周五完全看不出来）
- **价格解析与编码无关**：把页面按 Latin-1 解出的乱码副本喂进去，结果必须与 UTF-8 原文**完全一致**
  （§7.2 —— 只认中文标签的写法能过手工页，过不了真实抓取链路）
- **两个噪声行不得进表**：上下文长度行（`1M`）与紧随价格区段的并发限制行都不能被算成价格；
  价格区段靠「枚举连续六行、取第一个通过校验的组合」定位（§7.4 —— 并发行会把区段撑到 7 行）
- **峰时价必须严格大于闲时价**，否则整次同步作废、保留上一份好表，**绝不用半解析结果算钱**（§7.3）
- **同步默认关闭**：默认配置下不得产生任何到价格页的请求；只有按了 `同步价格` 或主动选了同步
  间隔才会跑（§7.6，也是两个 README 的隐私承诺）
- **同步缓存的落盘往返**保留 `models`、`capturedAt` 与 HTTP 校验器，且 `resolvePrices`
  如实给出 `source` 与 `capturedAt`（§7.5 —— 304 依赖校验器活下来）

> 写这些用例时踩过一个坑：给"B 消费了 5.5 元"的用例传了 **token 上界 = 0**，
> 于是按判据它必然被判成 `expire`（降幅超过上界），测试反而断言失败。
> 上界必须取**现实值**（≥ 该期间的真实消费额），否则用例本身就在构造不可能的场景。

---

## 附：源码地图

| 位置 | 内容 |
| --- | --- |
| `lib/client.js` → `PRICES` / `isPeakHour` / `costOf` | 价格表与四类计价 |
| `lib/client.js` → `parsePricingPage` / `resolvePrices` / `loadPriceCache` / `savePriceCache` / `syncPrices` / `readModels` / `BUILTIN_PRICES_DATE` / `PRICES_CACHE_KEY` / `SYNC_INTERVAL_HOURS` / `DEFAULT_SYNC_HOURS` | 价格同步：编码无关解析、语义校验、条件请求、来源标识（§7） |
| `lib/client.js` → `formatMoney` / `formatCostShort` / `formatCost` | 2 位 / 4 位显示与哨兵 |
| `lib/client.js` → `readBalance` / `readBonuses` | 两条回环路由的客户端封装 |
| `lib/client.js` → `readStore` / `writeStore` / `classifyRead` / `previousBalanceOf` / `observeRead` / `applyExternalChange` | 记账核心（纯逻辑，好测） |
| `lib/client.js` → `defaultSettings` / `normalizeSettings` / `loadSettings` / `saveSettings` / `createSettingsStore` / `useSettings` | 设置：配置容器与逐字段收敛（§4.1 / §4.2） |
| `lib/client.js` → `evaluateBudget` / `worstBudgetLevel` / `beijingDateKey` / `loadDaily` / `addDailySpent` / `minutesUntilTierChange` | 预算与峰谷（§4.3–§4.5） |
| `lib/client.js` → `BalanceHud` / `BalanceHudSettingsRow` | 组件：浮层与设置行（两个独立注册点，共享配置容器） |
| `lib/client.js` → `exports.__test` | 导出给冒烟测试的纯函数 |
| `lib/index.js` | Host 半边：只读回环路由 + 归一化（含可选的价格同步抓取，§7） |
