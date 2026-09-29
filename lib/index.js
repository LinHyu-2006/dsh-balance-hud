/**
 * dsh-balance-hud — Host 半边。
 *
 * UI-only 插件：不注册工具、不注入 prompt。Host 半边只做一件事——**替浏览器读余额**。
 *
 * 为什么不直接在浏览器半边调 `ctx.remote.account.getBalance`：客户端插件的
 * `ctx.remote` 受 Cordis 守卫保护（`cannot get property "remote.account" without inject`），
 * 而 `inject = ["remote"]` 在客户端侧又无法满足（fiber 一直挂起）。所以余额改由 Host
 * 通过 `ctx.deepseekAccount` 读取，再经一个**本机回环专用**只读路由交给浏览器。
 *
 * 路由约束：只认回环来源（127.0.0.1 / ::1），只读，只返回余额数字，
 * 不吐凭据、不接受任何写操作。
 *
 * @module dsh-balance-hud
 */

/** Cordis 插件名（诊断用）。 */
export const name = 'balance-hud';

/** 依赖：读余额要用账户服务，暴露路由要用 web 服务器。 */
export const inject = ['deepseekAccount', 'webServer'];

/** 余额路由路径，浏览器半边用同一个常量拼 URL。 */
const ROUTE = '/api/balance-hud/balance';

/**
 * 赠金确认路由。浏览器半边用它判断"余额跳高"是不是官方发放的赠金。
 *
 * 只读、不回执（**不调用 ackBonusNotified**）：回执会把赠金标成"已展示"，
 * 那会干扰 DSH 自己的赠金通知。这里只是拿它当信号读一眼，不消耗它。
 */
const BONUS_ROUTE = '/api/balance-hud/bonuses';

/**
 * 浏览器身份元数据：官方会把它转成 Platform 的客户端身份请求头。
 * @returns AccountClientMetadata 形状的对象。
 */
function clientMetadata() {
  return {
    version: '0.1.7-rc.2',
    locale: 'zh-CN',
    timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60,
  };
}

/**
 * 是否为回环请求。这个路由只服务同机浏览器。
 * @param request - 原始请求。
 * @returns 是否来自本机。
 */
function isLoopback(request) {
  const address = request?.socket?.remoteAddress ?? '';
  return (
    address === '127.0.0.1' ||
    address === '::1' ||
    address === '::ffff:127.0.0.1' ||
    address.startsWith('127.')
  );
}

/**
 * 把 `getBalance()` 的结果归一化成浏览器好用的形状。
 *
 * 三态：ready（有钱包）/ unavailable（未登录）/ error（查询失败）。
 * 与客户端半边 `readBalance` 的旧语义保持一致，改后端不改前端协议。
 *
 * @param value - `getBalance` 的返回值。
 * @returns 归一化结果。
 */
function normalize(value) {
  if (value === null || value === undefined) {
    return { kind: 'unavailable', reason: '账户未登录，或凭据在查询期间变更' };
  }
  if (value.status === 'failed') {
    return { kind: 'error', reason: 'Platform 拒绝了余额查询（凭据过期或网络失败）' };
  }
  const rechargeWallets = value.value ?? [];
  const bonus = (value.bonusWallets ?? []).filter((item) => Number(item.balance) > 0);
  const sum = (list) => list.reduce((total, item) => total + (Number(item.balance) || 0), 0);
  const currency =
    rechargeWallets.find((item) => Number(item.balance) !== 0)?.currency ??
    rechargeWallets[0]?.currency ??
    bonus[0]?.currency ??
    'CNY';
  const rechargeTotal = sum(rechargeWallets);
  const bonusTotal = sum(bonus);
  return {
    kind: 'ready',
    currency,
    rechargeTotal,
    bonusTotal,
    total: rechargeTotal + bonusTotal,
  };
}

/**
 * 归一化赠金批次：只保留浏览器判别充值需要的字段。
 *
 * 说明：**只读、不回执**。不调用 `ackBonusNotified`，因此不会影响 DSH 自己的
 * 赠金通知流程；这份数据会一直可读，浏览器半边用 orderId 去重即可。
 *
 * `expiresAt` 也一并透出：赠金**过期回收**会让余额凭空下降，是记账里必须
 * 与"消费"区分开的一类事件（客户端用 token 估算上界判定，不依赖这个字段），
 * 但把它显示出来能让用户提前知道哪笔赠金要到期。
 *
 * @param batch - `getUnnotifiedBonuses()` 的返回值。
 * @returns `{ kind, bonuses }`，bonuses 每项含 orderId / amount / grantedAt / expiresAt。
 */
function normalizeBonuses(batch) {
  if (batch === null || batch === undefined) {
    return { kind: 'unavailable', reason: '账户未登录，或凭据在查询期间变更', bonuses: [] };
  }
  const list = Array.isArray(batch.bonuses) ? batch.bonuses : [];
  return {
    kind: 'ready',
    bonuses: list.map((item) => ({
      orderId: String(item.orderId ?? ''),
      amount: Number(item.amount) || 0,
      currency: item.currency ?? 'CNY',
      grantedAt: String(item.grantedAt ?? ''),
      expiresAt: String(item.expiresAt ?? ''),
    })),
  };
}

/**
 * 回环校验 + JSON 应答的公共壳，两个只读路由共用。
 * @param request - 原始请求。
 * @param response - 原始应答。
 * @param produce - 产出 payload 的异步函数。
 * @returns 应答完成的 Promise。
 */
async function respondJson(request, response, produce) {
  if (!isLoopback(request)) {
    response.writeHead(403, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ kind: 'error', reason: '仅允许本机访问' }));
    return;
  }
  let payload;
  try {
    payload = await produce();
  } catch (error) {
    payload = {
      kind: 'error',
      reason: `查询异常：${error && error.message ? error.message : String(error)}`,
    };
  }
  response.writeHead(200, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(payload));
}

/**
 * 挂载 Host 半边：注册两个只读路由（余额、赠金信号）。
 * @param ctx - 宿主 Cordis 上下文。
 */
export function apply(ctx) {
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        method: 'GET',
        path: ROUTE,
        handler: (request, response) =>
          respondJson(request, response, async () => normalize(await ctx.deepseekAccount.getBalance(clientMetadata()))),
      }),
    'balance-hud: 只读余额路由',
  );

  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        method: 'GET',
        path: BONUS_ROUTE,
        // 只读、不回执：用来确认"余额跳高"是不是官方赠金，不影响 DSH 的赠金通知。
        handler: (request, response) =>
          respondJson(request, response, async () =>
            normalizeBonuses(await ctx.deepseekAccount.getUnnotifiedBonuses(clientMetadata())),
          ),
      }),
    'balance-hud: 只读赠金信号路由',
  );
}
