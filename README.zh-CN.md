[English](README.md) | **简体中文**

# dsh-balance-hud

**DSH（DeepSeek Harness）** Web GUI 右下角的常驻 HUD：一眼看到 DeepSeek **账户余额**和**本会话花费**。

[English](README.md) · [设计说明](docs/DESIGN.zh-CN.md) · [Design notes](docs/DESIGN.md) · [LICENSE](LICENSE)

```bash
node tools/install.mjs    # 安装到 ~/.dsh/profiles/desktop，然后重启 DSH
node tools/smoke.mjs      # 离线冒烟套件（53 条断言），不需要装 DSH
```

- **账户余额** —— 充值余额 + 赠金余额，走的是「设置 → 账号与余额」同一个服务
  （`ctx.deepseekAccount.getBalance()`）。
- **两条花费口径** —— 按官方价格表算的 token **预估**，以及由真实余额减少量累计出的**实际**值。
- **付充值无感** —— 充值只抬高余额，**不会打断花费计数**。
- **按会话独立** —— 基线与计数按会话 id 分槽存储；刷新页面或切换会话都不会覆盖别的会话。
- **不碰凭据、不外联** —— 插件从头到尾不接触你的 API key。
- **前后各半、一条中继** —— 浏览器半边负责渲染，Host 半边开两条只读回环路由供它读余额。

## 界面

```text
                                                        ┌──────────────────────────────┐
                                                        │  账户余额            ¥43.42  │
                                                        │  本会话预估           ¥0.59  │
                                                        └──────────────────────────────┘
```

把鼠标移到卡片上会展开明细面板：余额分项（充值 / 赠金 / 合计）、预估花费的三个计价分项、
实际值、token 用量，以及并行会话时的分摊行（`本会话占比`、`其它会话`、`跟踪会话`、
`账户级合计`）。展开面板用 4 位小数，小卡片用 2 位。

| 字段 | 含义 |
| --- | --- |
| `账户余额` | 账户合计（充值 + 赠金），2 位小数 |
| `本会话预估` | 本会话的预估花费；卡片 2 位、面板 4 位；会话还没有 token 用量时显示 `—` |
| `实际扣费` | 本会话累计的真实花费（单会话时；并行时改叫 `本会话分摊`） |

金额小于可显示的最小单位时，卡片显示 `<¥0.01`、面板显示 `<¥0.0001` —— 花了钱就**绝不会**被抹成 0。

## 交互

- **悬停卡片**展开明细面板。
- 卡片与面板是两个独立元素，中间留了 **8 px** 的视觉间隔。悬停判定挂在**卡片和面板自己**身上
  （各自有 enter / leave），不挂在外层定位容器上；并用一个 **140 ms** 的待关闭定时器，
  让指针落进那段间隔时面板的 `mouseenter` 能取消卡片的 `mouseleave`。
- 从**卡片左边**或**面板左边**滑出即收起。这是刻意的：容器在四周预留了空白，
  把收起判定挂在容器盒子上会让面板停在"其实已经离开"的空白处不消失。
- **点击卡片**折叠成角标（2 格：标签 + 余额），再点恢复。
- **键盘**：卡片是 `role="button"` + `tabIndex=0`，`Enter` / `空格` 切换折叠；面板是 `role="dialog"`。
- 面板里有 `刷新` 按钮（点击立刻显示忙碌文案，完成后给一个 `更新于 HH:MM:SS` 时间戳），
  以及手动兜底的 `我刚充值了` 按钮（处理中显示查询状态）。
- **HUD 里刻意没有任何 `title` 属性。** 原生浏览器 tooltip 会在悬停约一秒后弹出黑色方块盖住面板，
  所以摘要写在 `aria-label` 里。冒烟测试把这条当回归守卫断言。

## 两条花费口径

| 口径 | 算法 | 性质 |
| --- | --- | --- |
| **预估** | 会话 `tokenUsage` 投影 × 官方价格表 | 精确可算，但只覆盖模型 token |
| **实际** | 观测到的**余额减少量**累计求和，按会话存在 `localStorage` | 平台真实扣费，但有结算延迟 |

预估把用量拆成四类 token —— 未命中输入、缓存命中、缓存写、输出 —— 各自按峰谷两档价计价。
**缓存写按未命中输入价计**，与平台扣费口径一致。实际值是一个**计数器，不是做减法**：
每一次观测到的余额下降都加进当前会话的计数器，所以充值无法干扰它。

## 充值识别

**原则：外部变动改变余额，但绝不能改变花费计数。**

判据用的是 **token 估算上界**，而且它**双向都成立**：平台扣掉的钱不可能超过这段时间
消耗的 token 所值的钱；反过来，余额**减少**的量如果超过这个上界，多出来的部分也不可能来自消费。

```text
余额升幅 > 全部会话 token 估算之和 + 0.02  →  外部加钱：充值 / 赠金到账 / 账单修正
余额降幅 > 全部会话 token 估算之和 + 0.02  →  外部减钱：赠金过期回收 / 退款 / 账单修正
其余                                      →  普通消费，照常累计
```

这样既不会因为"充值和消费同时发生"漏判，也不会因为正常消费波动误判。

### 为什么必须处理"减钱"那个方向：赠金会过期

赠金有有效期。到期未用完的部分会被平台**回收**，表现为余额凭空下降、却没有任何消费。
早期版本把**任何**余额下降都算成消费（`delta < 0 → spend`），于是 5 元赠金过期会被记成
5 元"本会话花费"；而计数器只增不减，这个错误会一直留在记录里直到 30 天后被淘汰。

现在两个方向走**同一条路径**：只移动账户级字段（`baseline` / `lastBalance`），
**`spent` 原封不动**，并在 `topups[]` 里记下是哪一类变动。

多会话时，`applyExternalChange` 会把所有会话的账户级字段一起移动，但**刻意不动 `lastRead`**
（会话私有的"上次真正观测到的余额"）。于是每个会话都会自愈：还没观测到这次变动的会话，
下次读数时仍能看到完整落差，从而自己判出这是外部变动，而不会把它摊到自己的消费上。

### 三层，按权威度排序

1. **token 上界判据** —— 纯客户端、始终生效，是**权威**判据（两个方向都是它说了算）。
2. **官方赠金印证** —— `GET /api/balance-hud/bonuses` 读
   `ctx.deepseekAccount.getUnnotifiedBonuses()`。它是**只读且刻意不回执**的
   （不调 `ackBonusNotified`），因此**不会消费掉 DSH 自己的赠金通知**；数据保持可读，
   客户端按 `orderId` 去重。即使这条路由不通，变动仍会被识别 —— 这一层只是印证。
   注意：**它只能印证"发放"，官方没有"过期"的推送**，所以减钱那个方向完全靠第 1 层。
   顺带把官方给的 `expiresAt` 透出来，提示里会带上"最早到期"日期。
3. **手动兜底** —— `我刚充值了` 按钮走同一条重锚路径，处理期间显示"查询中…"。

面板会显示约 12 秒的提示，两类都有：

- 加钱：`已识别充值 ¥50.00，花费继续累计（官方赠金 ¥5.00 印证），最早到期 2025-12-31。`
- 减钱：`检测到 ¥5.00 非消费性扣减（赠金过期回收等），未计入花费。`

## 并行会话与分摊

账户余额是**账户级**的：它不携带"这笔钱是哪个会话花的"，所以单个会话的真实花费
**在本地不可观测**。插件用比例分摊：

```text
本会话分摊 = 本会话累计花费 × (本会话 token 成本 / 全部会话 token 成本)
```

所有会话的 token 成本都用同一套四类计价 + 峰谷价，权重才可比。只有一个会话时权重恒为 1，
数值就退化成精确值。

**这是估算。** 两个会话的 token 消耗与平台结算并不同步，比例会漂移；有新会话加入分母时，
数字会下跳一次。面板里有 `本会话占比`、`其它会话`、`跟踪会话` 几行，能看到当时的权重是多少。

## 持久化

记录在 `localStorage` 的 `dsh-balance-hud:tracker:v4` 下，按会话 id 分槽：

```json
{ "sessions": { "<会话id>": { "baseline": 43.42, "lastBalance": 43.12, "spent": 0.3, "ts": 0 } } }
```

| 情况 | 行为 |
| --- | --- |
| 刷新页面 / 重新挂载 | 从 `localStorage` 读回，计数器继续累计 |
| 切换会话 | 各会话有自己的记录，互不覆盖、互不清零 |
| 识别到充值 | 只移动基线，`spent` 不动 |
| 记录超过 30 天 | 写回时淘汰 |
| 超过 30 个会话 | 保留最近 30 个 |
| `localStorage` 不可用 | 降级为仅内存，HUD 照常工作 |

页面存活期间，内存里的 store 还带着一个 `topups[]` 历史和一个 `lastObservedBalance`；
但**当前写盘只持久化 `sessions`**。老数据会自动迁移 —— `v3` 是 `{ sessions: { … } }`、
`v2` 是扁平的 `{ [会话id]: { … } }` 字典、`v1` 是单条 `{ sessionId, … }` —— 迁完会删掉旧键。

余额每 **60 秒**拉一次（页面隐藏时 **5 分钟**），页面回到前台立刻补读，
失败按 1s → 2s → 5s → 10s → 20s 退避重试。未登录不算错误，也不会走快速重试。

## 架构

```text
浏览器（客户端半边 lib/client.js）              Host（Host 半边 lib/index.js）
  注册 shell.overlay 槽位                        inject: [deepseekAccount, webServer]
  每 60 秒轮询一次                               │
  fetch ──────────────────────────────────────► GET /api/balance-hud/balance   （只读）
                                                GET /api/balance-hud/bonuses   （只读）
                                                └─► ctx.deepseekAccount.getBalance()
                                                    ctx.deepseekAccount.getUnnotifiedBonuses()
                                                     └─► 官方 account platform
```

**为什么需要这条中继。** 浏览器半边无法直接调 `ctx.remote.account.getBalance`：
不声明就访问会抛 `cannot get property "remote.account" without inject`；
而在客户端半边声明 `inject = ["remote"]` 又无法满足 —— fiber 永久挂起，插件根本不激活。
两条都在真实 `@deepseek-ai/cordis` 4.0.4 上复现过。所以由 Host 半边读余额，
再经**仅回环、只读**的路由交给浏览器。两条路由都**只接受回环来源**
（`127.0.0.1`、`::1`、IPv4 映射回环形式），其它一律 `403`；只支持 `GET`，
不改任何状态，不返回凭据，并带 `cache-control: no-store`。

| 返回 | 含义 | HUD 显示 |
| --- | --- | --- |
| `{ kind: 'ready', currency, rechargeTotal, bonusTotal, total }` | 已登录且有钱包 | `¥xx.xx` |
| `{ kind: 'unavailable', reason }` | 未登录 / 凭据在查询期间变更 | 未登录 |
| `{ kind: 'error', reason }` | 查询失败、路由不可达、响应不合法 | 读取失败（原因在面板里） |

## 价格口径

单位 **元 / 百万 tokens**，取自官方
[模型 & 价格](https://api-docs.deepseek.com/zh-cn/quick_start/pricing)；闲时价恰好是峰时价的一半。

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash` | 闲 0.02 / 峰 0.04 | 闲 1 / 峰 2 | 闲 4 / 峰 8 |
| `deepseek-v4-pro` | 闲 0.15 / 峰 0.30 | 闲 4.5 / 峰 9 | 闲 13.5 / 峰 27 |

- **峰时** = 北京时间周一至周五 09:00–12:00 与 14:00–18:00。其余时段（含周末与法定节假日）
  按闲时计；只取本地时间的「星期 + 小时」换算，不引入时区库。
- **缓存写**按未命中输入价计费。
- 槽位注入里模型目前固定为 `deepseek-flash`；`lib/client.js` 的 `PRICES` 里两个模型都有。
  未知模型回落到 flash 价格（而不是归零），面板会说明这一点。
- 官方调价后改 `PRICES` 再刷新页面即可。

## 安装

这是一个本地 profile 插件，**不发布到 npm**。

```powershell
node tools/install.mjs                     # 安装到 ~/.dsh/profiles/desktop
node tools/install.mjs --dry-run           # 预览，不写任何文件
node tools/install.mjs --uninstall         # 卸载
node tools/install.mjs --profile <dir>     # 指定别的 profile
```

手工安装等价于：

1. 把目录放到 `~/.dsh/profiles/<profile>/plugins/dsh-balance-hud`
   （客户端 bundle 是从 profile 提供的，所以必须真的在 profile 目录里）。
2. 在 profile 的 `dependencies` 加 `"dsh-balance-hud": "file:./plugins/dsh-balance-hud"`，
   并在 `dsh.profile.bundles` 里加 `"dsh-balance-hud"`。
3. 把它链接进 profile 的 `node_modules`（Windows 用 junction，其它平台用符号链接）。
4. 重启 DSH。

> **注意**：profile 的 `package.json` **不能带 UTF-8 BOM**。带 BOM 时插件管理器会以
> `Unexpected token '\ufeff'` 失败。`tools/install.mjs` 会把清单重写成不带 BOM 的版本，
> 并保留一份 `package.json.bak-balance-hud` 备份。

改**客户端**半边（`lib/client.js`）只需刷新页面。改 **Host** 半边（`lib/index.js`，
例如那条赠金路由）需要**重启 DSH**，因为 profile bundles 不热加载。

## 开发

```bash
node tools/smoke.mjs                      # 离线冒烟套件，不需要装 DSH
node tools/verify-install.mjs --package   # 打包自检，不需要装 DSH
node tools/verify-install.mjs             # 校验真实安装
```

`tools/smoke.mjs` 会在假的 React 运行时、假 Host 响应、假 `localStorage` 和假 `document`
上求值真实的 `lib/client.js`，然后驱动组件走完整个 hook 周期。每项检查打印一行 `✓`
（共 53 条），首个失败即非零退出；覆盖模块/槽位注册、卡片布局、悬停与折叠交互、
余额协议与全部路由失败模式、价格算术、显示精度、**充值/过期两类外部变动判据**、
持久化与迁移链，以及可见性驱动的补读。

它**不覆盖** Host 半边（`lib/index.js` 从未被加载）、真实浏览器、真实 Cordis 注入和真实平台。
`lib/client.js` 是手写的 CJS 风格 bundle，格式就是官方的
`window.__ModuleLoader__.load({ id, factory })`，所以**没有构建步骤**。

| 文件 | 作用 |
| --- | --- |
| `package.json` | 声明 `dsh.bundle.patch`（profile 条目树）与 `dsh.client`（`platform: web`，导出 `./client`） |
| `cordis.patch.yml` | 把插件作为一行插入 profile 条目树 |
| `lib/index.js` | Host 半边：两条只读回环路由 |
| `lib/client.js` | 浏览器半边：`shell.overlay` HUD 与全部记账逻辑 |
| `tools/` | 安装脚本、安装校验、离线冒烟套件 |
| `docs/DESIGN.zh-CN.md` | 贡献者设计说明 —— 记账模型的完整推导 |

## 隐私与安全

- **本插件从不接触官方 API key。** Host 半边只调 `getBalance` 和 `getUnnotifiedBonuses`，
  **从不调** `resolveToken` 或 `getPlatformSession`，凭据始终留在
  `@deepseek-ai/dsh-deepseek-account-platform` 内部。
- 仓库里、`localStorage` 里、HUD 上都没有密钥、令牌或账号 id。
- 插件新增的网络流量**只有**到 `/api/balance-hud/…` 的回环 HTTP。它不向任何第三方发送数据；
  Host 半边对平台的调用走的是 DSH 本来就用的账号服务。
- 两条路由对非回环调用者一律 `403`，且只返回余额数字。
- 赠金路由既只读又**不回执**，因此不可能吞掉 DSH 自己的赠金通知。

## 已知边界

- **预估只覆盖模型 token。** 任何非 token 计费项（插件、检索等）都会让它偏低。
- **分摊是估算**；凡是拿不到用量投影的会话在分母里权重为 0，会让占比失真。
- **赠金"部分过期"可能被算成消费。** 判据是"降幅是否超过 token 上界"：如果某笔赠金
  只有一部分过期，且这笔降幅恰好落在上界以内，就会被当成消费。要彻底解决需要**按钱包分项的
  余额明细**（哪个钱包、多少、何时过期），而 `getBalance()` 返回的 `AccountWallet` 只有
  `{ currency, balance }`，**不含过期时间**。所以这是"把误差压到不超过 token 估值"，
  不是消除。
- **拿不到 token 数据时判据会变紧。** 上界退化为 0 附近，此时较大的真实消费有可能被
  误判为外部减钱。实际运行中 token 用量每 5 秒读一次，这种情况罕见。
- **平台结算有延迟。** 刚跑完任务时实际值可能还停在原处，而预估已经动了；
  两者会在几十秒内收敛。
- **第一个基线略晚于会话开始**，更早的花费由 token 预估覆盖。
- **账户级合计只是参照**，不是某个会话的数字。
- **未登录是正常状态**：卡片会说明，登录后下一次轮询自动恢复。

## 许可

MIT，见 [LICENSE](LICENSE)。
