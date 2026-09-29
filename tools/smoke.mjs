/**
 * dsh-balance-hud 客户端半边的离线冒烟测试。
 *
 * 做法：真的把 client.js 求值一遍（模块注册 → require → apply → 取槽位注册结果），
 * 再用一个最小函数组件运行器执行 hook 循环（useState / useEffect / useRef），验证：
 *
 *  1. 模块与槽位注册形状、竖排两列网格布局；
 *  2. 不得有原生 tooltip（title 会在一秒后弹黑框盖住面板）；
 *  3. 悬停展开、跨 8px 间隔移进面板不得收起、从卡片/面板左侧滑出必须收起、点击折叠；
 *  4. 余额三态（读取中 / 未登录 / 读取失败）与 Host 路由异常的各种形态；
 *  5. 价格表口径：四类 token 分别计价、峰谷两档、缓存写按未命中价；
 *  6. 显示精度：卡片 2 位 / 面板 4 位，以及 `<¥0.01` 这类"不为零"哨兵；
 *  7. **充值识别**：余额升幅超过 token 估算上界 → 只抬基线、**不改变花费计数**；
 *     以及手动兜底、赠金印证、「查询中…」状态；
 *  8. 持久化：按会话分槽、跨刷新存活、切会话不串号、v3/v2/v1 迁移、过期与超量淘汰；
 *  9. 页面可见性联动（回前台立刻补读）。
 *
 * 运行：node tools/smoke.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

//#region 最小 React 运行器
/** 每个 hook 槽位：state / effect / hook(标准 share)。 */
const slots = [];
let cursor = 0;
let effectQueue = [];

const React = {
  Fragment: Symbol('Fragment'),
  createElement: (type, props, ...children) => ({
    type,
    props: props ?? {},
    children: children.flat(Infinity)
  }),
  useState(initial) {
    const index = cursor++;
    if (slots[index] === undefined) {
      slots[index] = { kind: 'state', value: typeof initial === 'function' ? initial() : initial };
    }
    const slot = slots[index];
    return [
      slot.value,
      (next) => {
        slot.pending ??= [];
        slot.pending.push(next);
      }
    ];
  },
  useEffect(fn, deps) {
    const index = cursor++;
    const previous = slots[index];
    const changed =
      previous === undefined ||
      deps === undefined ||
      previous.deps === undefined ||
      deps.length !== previous.deps.length ||
      deps.some((dep, i) => !Object.is(dep, previous.deps[i]));
    if (!changed) return;
    if (typeof previous?.cleanup === 'function') previous.cleanup();
    const slot = { kind: 'effect', deps, run: fn, cleanup: undefined };
    slots[index] = slot;
    effectQueue.push(slot);
  },
  /** useRef 替身：普通对象即可，但要**尊重 initialValue**（组件依赖它初始化基准对象）。 */
  useRef(initial) {
    const index = cursor++;
    slots[index] ??= { kind: 'ref', current: typeof initial === 'function' ? initial() : (initial ?? null) };
    return slots[index];
  }
};

/** 支持选择器的标准 share 替身（useSessions 的形状）。 */
function observableHook(source) {
  return (selector) => {
    const index = cursor++;
    slots[index] ??= { kind: 'hook', source, selector };
    slots[index].selector = selector;
    const value = source?.getSnapshot?.();
    return typeof selector === 'function' ? selector(value) : value;
  };
}

/** 落地所有排队的 setState（模拟 React 批处理提交）。 */
function flushState() {
  for (const slot of slots) {
    if (slot === undefined || slot.pending === undefined) continue;
    for (const next of slot.pending) {
      slot.value = typeof next === 'function' ? next(slot.value) : next;
    }
    slot.pending.length = 0;
  }
}

function flushEffects() {
  const queue = effectQueue;
  effectQueue = [];
  for (const slot of queue) {
    const cleanup = slot.run();
    slot.cleanup = typeof cleanup === 'function' ? cleanup : undefined;
  }
}

/** 让挂起的微任务（fetch 的 await）落地。 */
async function settle() {
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  await new Promise((resolve) => setImmediate(resolve));
}

/** 最小 localStorage 替身：基线的持久化要靠它。 */
function installStorageMock() {
  const map = new Map();
  const storage = {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => map.set(key, String(value)),
    removeItem: (key) => map.delete(key),
    clear: () => map.clear(),
    get size() {
      return map.size;
    }
  };
  globalThis.localStorage = storage;
  return storage;
}

/** 最小 document 替身：可见性判断 + 指针事件派发。 */
function installDocumentMock(hidden = false) {
  const visibility = new Set();
  const pointer = new Set();
  const leave = new Set();
  globalThis.document = {
    hidden,
    addEventListener: (type, fn) => {
      if (type === 'visibilitychange') visibility.add(fn);
      if (type === 'pointermove') pointer.add(fn);
      if (type === 'pointerleave') leave.add(fn);
    },
    removeEventListener: (type, fn) => {
      if (type === 'visibilitychange') visibility.delete(fn);
      if (type === 'pointermove') pointer.delete(fn);
      if (type === 'pointerleave') leave.delete(fn);
    },
    dispatchEvent: (event) => {
      if (event.type === 'pointermove') for (const fn of pointer) fn(event);
      if (event.type === 'pointerleave') for (const fn of leave) fn(event);
    }
  };
  return {
    setHidden(value) {
      globalThis.document.hidden = value;
      for (const fn of visibility) fn();
    },
    listenerCount: () => visibility.size,
    pointerListenerCount: () => pointer.size,
    movePointer(x, y) {
      globalThis.document.dispatchEvent({ type: 'pointermove', clientX: x, clientY: y });
    },
    leaveWindow() {
      globalThis.document.dispatchEvent({ type: 'pointerleave' });
    }
  };
}
//#endregion

//#region 求值客户端半边
const captured = [];
globalThis.window = { __ModuleLoader__: { load: (record) => captured.push(record) } };

// 客户端 bundle 的位置从**脚本自身位置**派生，不写死绝对路径。
// 也支持用 DSB_HUD_CLIENT 指到任意一份（例如已安装的 profile 副本）。
const here = path.dirname(fileURLToPath(import.meta.url));
const clientPath =
  process.env.DSB_HUD_CLIENT ?? path.join(here, '..', 'lib', 'client.js');
const source = fs.readFileSync(clientPath, 'utf8');
const requireShim = (name) => {
  if (name === 'react') return React;
  throw new Error(`unexpected require(${name})`);
};
new Function('window', 'require', 'module', 'exports', source)(
  globalThis.window,
  requireShim,
  { exports: {} },
  {}
);

if (captured.length !== 1) throw new Error(`期望 1 条模块注册，实际 ${captured.length}`);
const record = captured[0];
if (record.id !== 'dsh-balance-hud') throw new Error(`模块 id 不符：${record.id}`);
const plugin = record.factory(requireShim);
if (typeof plugin.apply !== 'function') throw new Error('缺少 apply');
if (!Array.isArray(plugin.inject)) throw new Error('缺少 inject');
console.log(`✓ 模块注册：id=${record.id}，inject=${JSON.stringify(plugin.inject)}`);
//#endregion

//#region 假宿主数据
const SESSION_ACTIVE = 'sess-aaaa1111';
const SESSION_IDLE = 'sess-bbbb2222';

const USAGE = {
  uncachedInputTokens: 120000,
  cacheReadTokens: 3400000,
  cacheWriteTokens: 50000,
  outputTokens: 88000
};

/** Host 只读路由返回的 JSON（三态协议）。 */
const READY_PAYLOAD = {
  kind: 'ready',
  currency: 'CNY',
  rechargeTotal: 38.4213,
  bonusTotal: 5,
  total: 43.4213
};

/** 假的余额合计：切换会话的用例要让它随时间下降，模拟平台扣费。 */
let balanceTotal = 43.4213;

let balanceReads = 0;
/** 赠金路由的调用次数与行为（'ok' | 'hang' | 'error'）。 */
let bonusesReads = 0;
let bonusMode = 'ok';
/** 赠金路由返回的条目。 */
let bonusPayload = [];
/**
 * 余额路由的行为模式：
 * ready / hang / unavailable / error / http500 / badjson / badshape / unreachable。
 */
let balanceMode = 'ready';

/**
 * 假的 Host 余额路由。客户端半边只通过 fetch 取余额
 * （客户端插件不能访问 ctx.remote —— Cordis 依赖守卫会抛
 * `cannot get property "remote.account" without inject`）。
 */
function installFetchMock() {
  globalThis.fetch = async (url, init) => {
    balanceReads += 1;
    if (typeof url === 'string' && !url.startsWith('/api/balance-hud/balance') && !url.startsWith('/api/balance-hud/bonuses')) {
      throw new Error(`请求了意外的 URL：${url}`);
    }
    if (init?.method !== 'GET') throw new Error(`请求方法不是 GET：${init?.method}`);
    // 赠金信号路由：单独处理，好让用例精确控制"印证"的返回
    if (typeof url === 'string' && url.startsWith('/api/balance-hud/bonuses')) {
      bonusesReads += 1;
      if (bonusMode === 'hang') return new Promise(() => {});
      if (bonusMode === 'error') throw new Error('Failed to fetch');
      return {
        ok: true,
        status: 200,
        json: async () => ({ kind: 'ready', bonuses: bonusPayload })
      };
    }
    switch (balanceMode) {
      case 'hang':
        return new Promise(() => {});
      case 'unreachable':
        throw new Error('Failed to fetch');
      case 'http500':
        return { ok: false, status: 500, json: async () => ({}) };
      case 'badjson':
        return { ok: true, status: 200, json: async () => { throw new Error('not json'); } };
      case 'badshape':
        return { ok: true, status: 200, json: async () => ({ nope: true }) };
      case 'unavailable':
        return { ok: true, status: 200, json: async () => ({ kind: 'unavailable', reason: '账户未登录' }) };
      case 'error':
        return { ok: true, status: 200, json: async () => ({ kind: 'error', reason: 'Platform 拒绝了余额查询' }) };
      default:
        return {
          ok: true,
          status: 200,
          json: async () => ({
            ...READY_PAYLOAD,
            total: balanceTotal,
            rechargeTotal: balanceTotal - READY_PAYLOAD.bonusTotal
          })
        };
    }
  };
}

/** 当前被 mainView 保留的会话（可切换，用来模拟用户换会话）。 */
let activeSession = 'sess-aaaa1111';
const sessionsSource = {
  getSnapshot: () => ({
    byId: {
      [SESSION_ACTIVE]: {
        id: SESSION_ACTIVE,
        retainedBy: SESSION_ACTIVE === activeSession ? { mainView: 1 } : {}
      },
      [SESSION_IDLE]: {
        id: SESSION_IDLE,
        retainedBy: SESSION_IDLE === activeSession ? { mainView: 1 } : {}
      }
    }
  }),
  subscribe: () => () => {}
};

function makeCtx({ usage }) {
  const registered = [];
  let face;
  return {
    registered,
    ctx: {
      effect: (fn) => {
        fn();
        return () => {};
      },
      slots: {
        hooks: { sessions: sessionsSource },
        inject: (slot, fn) => {
          fn();
          return () => {};
        },
        register: (options, Component) => {
          registered.push({ slot: options.name, options, Component });
          return () => {};
        }
      },
      sessions: {
        binding: (id) => {
          if (id !== SESSION_ACTIVE) return undefined;
          face ??= { getSnapshot: () => usage, subscribe: () => () => {} };
          return { session: { projections: { faceOf: () => face } } };
        }
      }
    }
  };
}

/**
 * 挂载组件并跑到状态收敛。
 * @param options - 用量、是否提供 useSessions share、余额路由的行为模式。
 * @returns 最后一次渲染的树、注册项、注入 props、插件对象与 document 替身。
 */
async function mount({ usage, withSessionsShare = true, mode = 'ready', balance = 43.4213 }, passes = 6) {
  balanceMode = mode;
  balanceTotal = balance;
  activeSession = SESSION_ACTIVE;
  bonusMode = 'ok';
  bonusPayload = [];
  bonusesReads = 0;
  installFetchMock();
  installStorageMock();
  const doc = installDocumentMock(false);

  const { ctx, registered } = makeCtx({ usage });
  plugin.apply(ctx);
  // 现在有两个注册点：浮层 + 设置里的偏好行
  if (registered.length !== 2) throw new Error(`期望 2 个槽位注册，实际 ${registered.length}`);
  const overlayEntry = registered.find((entry) => entry.slot === 'shell.overlay');
  const settingsEntry = registered.find((entry) => entry.slot === 'settings.general.item');
  if (overlayEntry === undefined) throw new Error('没有注册 shell.overlay');
  if (settingsEntry === undefined) throw new Error('没有注册 settings.general.item');
  const { options, Component } = overlayEntry;
  if (options.name !== 'shell.overlay') throw new Error(`槽位名不符：${options.name}`);
  if (options.id !== 'balance-hud') throw new Error(`槽位 id 不符：${options.id}`);

  const injected = options.inject();
  const props = withSessionsShare ? { ...injected, useSessions: observableHook(sessionsSource) } : injected;

  slots.length = 0;
  effectQueue = [];
  let tree;
  const step = async () => {
    // 模拟一次 React 提交，顺序很重要：
    //   渲染 → 执行 effect（发起异步请求）→ 等微任务/定时器落地 →
    //   渲染（此时异步结果已排队）→ flushState 落地 → 再渲染一次（呈现新状态）
    // 少最后一步就会返回"状态更新之前"的树，导致面板缺行之类的误判。
    cursor = 0;
    tree = Component(props);
    flushEffects();
    await settle();
    for (let round = 0; round < 3; round += 1) {
      cursor = 0;
      tree = Component(props);
      flushState();
      flushEffects();
    }
    return tree;
  };
  for (let i = 0; i < passes; i += 1) await step();
  return { tree, options, props, plugin, doc, renderAgain: step };
}
//#endregion

//#region 断言工具
function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join(' ');
  return [].concat(node.children ?? []).map(textOf).join(' ');
}

/** 深度优先找第一个满足条件的节点。 */
function findNode(node, predicate) {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const hit = findNode(child, predicate);
      if (hit !== undefined) return hit;
    }
    return undefined;
  }
  if (predicate(node)) return node;
  for (const child of [].concat(node.children ?? [])) {
    const hit = findNode(child, predicate);
    if (hit !== undefined) return hit;
  }
  return undefined;
}

/** 明细面板（role="dialog"）——注意不能用文字判断，文本会含 aria-label 内容。 */
const panelOf = (tree) => findNode(tree, (node) => node?.props?.role === 'dialog');
/** 徽标（role="button"）。不能用 title 找，title 已被移除。 */
const badgeOf = (tree) => findNode(tree, (node) => node?.props?.role === 'button');
/** 悬停外层容器（只负责展开）。 */
const hoverSurfaceOf = (tree) => findNode(tree, (node) => typeof node?.props?.onMouseEnter === 'function');

/** 给节点注入假矩形（测试里替代真实 DOM 布局）。 */
function withRect(node, rect) {
  node.getBoundingClientRect = () => ({
    ...rect,
    width: rect.right - rect.left,
    height: rect.bottom - rect.top
  });
  return node;
}

function expectIncludes(label, text, needles) {
  const missing = needles.filter((needle) => !text.includes(needle));
  if (missing.length > 0) throw new Error(`${label}: 缺少 ${JSON.stringify(missing)}\n实际：${text}`);
  if (text.includes('undefined') || text.includes('NaN')) {
    throw new Error(`${label}: 出现 undefined/NaN\n实际：${text}`);
  }
  console.log(`✓ ${label}`);
  console.log(`  ${text.replace(/\s+/g, ' ').trim().slice(0, 220)}`);
}

/** 反复重渲染直到条件成立（或超时）。 */
async function until(run, predicate, attempts = 4, waitMs = 0) {
  for (let i = 0; i < attempts; i += 1) {
    const tree = await run();
    if (predicate(tree)) return tree;
    if (waitMs > 0) await new Promise((resolve) => setTimeout(resolve, waitMs));
  }
  return undefined;
}
//#endregion

//#region 用例
// 1) 正常路径：已登录 + 本会话有用量
const normal = await mount({ usage: USAGE });
const normalText = textOf(normal.tree);
expectIncludes('已登录 + 有用量', normalText, ['余额', '¥43.42', '本会话']);
if (!/本会话预估\s*¥0\.\d{2}(?!\d)/.test(normalText.replace(/\s+/g, ' '))) {
  throw new Error(`本会话预估未渲染出金额：${normalText}`);
}
if (balanceReads < 1) throw new Error('未调用 Host 余额路由');
// 标签必须写具体，不能再用单字「实」
if (/\s实\s/.test(normalText)) throw new Error('不应再出现单字标签「实」');

// 1b) 布局：两列网格、**只剩 2 行**（方案 2：预估与分摊合并成「本会话预估」）
const badge = badgeOf(normal.tree);
if (badge?.props?.style?.display !== 'inline-grid') {
  throw new Error(`徽标应为 inline-grid，实际 ${badge?.props?.style?.display}`);
}
if (badge.props.style.gridTemplateColumns !== 'auto auto') {
  throw new Error(`徽标应为两列网格，实际 ${badge.props.style.gridTemplateColumns}`);
}
const cells = (badge.children ?? []).filter(Boolean);
if (cells.length !== 4) throw new Error(`合并后应为 2 行 × 2 列 = 4 格，实际 ${cells.length}`);
const labels = cells.filter((_, index) => index % 2 === 0).map(textOf);
const values = cells.filter((_, index) => index % 2 === 1).map(textOf);
if (labels.join('|') !== '账户余额|本会话预估') {
  throw new Error(`标签列不符（应只剩两行）：${labels.join('|')}`);
}
if (!values[0].includes('¥43.42') || !values[1].includes('¥')) {
  throw new Error(`数值列缺失金额：${values.join('|')}`);
}
// 小卡片金额精确到 2 位小数（不该出现 4 位）
for (const value of values) {
  if (/¥\d+\.\d{3,}/.test(value)) throw new Error(`小卡片金额应为 2 位小数：${value}`);
}
// 对齐方式：标签左对齐、数值右对齐
for (let i = 0; i < cells.length; i += 1) {
  const expected = i % 2 === 0 ? 'left' : 'right';
  if (cells[i].props.style.textAlign !== expected) {
    throw new Error(`第 ${i} 格应 ${expected} 对齐，实际 ${cells[i].props.style.textAlign}`);
  }
}
console.log(`✓ 布局：两列网格 2 行｜标签 ${labels.join(' / ')}｜数值 ${values.join(' / ')}`);

// 2) 官方价格表口径：flash 闲时
const flashOff = (u) =>
  ((u.uncachedInputTokens + u.cacheWriteTokens) / 1e6) * 1 +
  (u.cacheReadTokens / 1e6) * 0.02 +
  (u.outputTokens / 1e6) * 4;
const expectedOff = flashOff(USAGE).toFixed(4);
// 小卡片按 2 位小数显示同一数值
const expectedOffShort = Number(expectedOff).toFixed(2);
if (!normalText.includes(`¥${expectedOffShort}`)) {
  throw new Error(`小卡片闲时价口径不符：期望 ¥${expectedOffShort}，实际 ${normalText}`);
}
console.log(`✓ 价格表口径（flash 闲时）：面板 ¥${expectedOff} / 小卡片 ¥${expectedOffShort}`);

// 2b) 精度：小卡片 2 位、明细面板 4 位（纯函数直接断言，不依赖异步时序）
const { formatCost: exact, formatCostShort: short } = normal.plugin.__test;
if (short(0.59, '¥') !== '¥0.59') throw new Error(`小卡片应为 2 位：${short(0.59, '¥')}`);
if (short(0.5937, '¥') !== '¥0.59') throw new Error(`小卡片应四舍五入到 2 位：${short(0.5937, '¥')}`);
if (short(0, '¥') !== '¥0.00') throw new Error(`小卡片零值：${short(0, '¥')}`);
if (short(0.001, '¥') !== '<¥0.01') throw new Error(`小卡片不得把花了钱显示成 0：${short(0.001, '¥')}`);
if (exact(0.5937, '¥') !== '¥0.5937') throw new Error(`面板应为 4 位：${exact(0.5937, '¥')}`);
if (exact(0, '¥') !== '¥0.0000') throw new Error(`面板零值：${exact(0, '¥')}`);
if (exact(0.00001, '¥') !== '<¥0.0001') throw new Error(`面板最小单位哨兵：${exact(0.00001, '¥')}`);
const balanceDigits = normal.plugin.__test.formatMoney(43.4213, '¥');
if (balanceDigits !== '¥43.42') throw new Error(`余额应为 2 位：${balanceDigits}`);
console.log('✓ 精度：小卡片 2 位（¥0.59 / <¥0.01）、明细面板 4 位（¥0.5937 / <¥0.0001）、余额 2 位');
// 3) 不得再有原生 tooltip（title）：悬停约 1 秒后浏览器会弹黑框
if (badge.props.title !== undefined) throw new Error(`徽标不应有 title：${badge.props.title}`);
for (const node of [badge, ...(badge.children ?? [])].filter(Boolean)) {
  if (node?.props?.title !== undefined) throw new Error('子节点上残留 title');
}
console.log('✓ 无原生 tooltip（title 已移除，黑框不会再出现）');

// 3b) 无障碍摘要走 aria-label
const ariaLabel = badge.props['aria-label'];
if (typeof ariaLabel !== 'string' || !ariaLabel.includes('¥43.42')) {
  throw new Error(`aria-label 摘要不完整：${ariaLabel}`);
}
console.log(`✓ aria-label 摘要：${ariaLabel}`);

// 4) 悬停 / 收起 —— **两个元素各自判断**
//
// 面板宽 286px、卡片窄（约 96px）且靠右，错开形成的区域不是矩形：
// 任何单一容器的盒子都会多出"左边有、下面没有"的空白。
// 所以悬停由卡片和面板各自的 mouseenter/mouseleave 承担：
//   · 指针移到卡片上 → 卡片 enter → 展开
//   · 从卡片往上移到面板 → 面板 enter 取消待收起 → 面板保持
//   · 从**卡片左侧**滑出（下方那片空白）→ 卡片 leave，无后续 enter → 收起
//   · 从**面板左侧**滑出 → 面板 leave，无后续 enter → 收起
const hoverRun = await mount({ usage: USAGE });
if (panelOf(hoverRun.tree) !== undefined) throw new Error('未悬停时不应展示明细面板');

const card0 = badgeOf(hoverRun.tree);
if (typeof card0.props.onMouseEnter !== 'function' || typeof card0.props.onMouseLeave !== 'function') {
  throw new Error('卡片自身应有 onMouseEnter / onMouseLeave');
}
// 外层容器只做定位与留白，不应再承担悬停判定。
// 用 gap + flexDirection 特征定位它（不能用 onMouseEnter —— 卡片上也有）。
const surface0 = findNode(
  hoverRun.tree,
  (node) => node?.props?.style?.gap === '8px' && node?.props?.style?.flexDirection === 'column'
);
if (surface0 !== undefined && typeof surface0.props.onMouseLeave === 'function') {
  throw new Error('外层容器不应挂 onMouseLeave（会漏掉卡片左侧的空白）');
}
console.log('✓ 结构：悬停判定挂在卡片与面板上，容器只负责定位与 8px 留白');

// 4a) 指针进入卡片 → 展开
card0.props.onMouseEnter();
const opened = await until(hoverRun.renderAgain, (tree) => panelOf(tree) !== undefined, 4);
if (opened === undefined) throw new Error('指针进入卡片后明细面板未出现');
const expandedText = textOf(panelOf(opened));
for (const needle of ['账户余额', '本会话花费', '刷新']) {
  if (!expandedText.includes(needle)) throw new Error(`悬停面板缺少「${needle}」：${expandedText}`);
}
console.log('✓ 指针进入卡片：明细面板出现');
console.log(`  ${expandedText.replace(/\s+/g, ' ').trim().slice(0, 240)}`);

// 4b) 从卡片往上移到面板：卡片的 leave 先来，面板的 enter 随后取消收起
badgeOf(opened).props.onMouseLeave();
const panelNode = panelOf(opened);
if (typeof panelNode.props.onMouseEnter !== 'function') throw new Error('面板应有 onMouseEnter');
panelNode.props.onMouseEnter();
const stillOpen = await until(hoverRun.renderAgain, (tree) => panelOf(tree) !== undefined, 3, 200);
if (stillOpen === undefined) throw new Error('从卡片移到面板上时面板消失了');
console.log('✓ 卡片 → 面板（跨 8px 留白）：面板保持');

// 4c) 从卡片左侧滑出（下方那片"容器内但不在元素上"的空白）→ 必须收起
badgeOf(stillOpen).props.onMouseLeave();
const closedFromCard = await until(hoverRun.renderAgain, (tree) => panelOf(tree) === undefined, 4, 200);
if (closedFromCard === undefined) {
  throw new Error('从卡片左侧滑出时面板没有收起（这就是"左侧是详情页左侧"的问题）');
}
console.log('✓ 从卡片左侧滑出：面板收起');

// 4d) 从面板左侧滑出 → 也必须收起
const reopen = await mount({ usage: USAGE });
badgeOf(reopen.tree).props.onMouseEnter();
const panelShown = await until(reopen.renderAgain, (tree) => panelOf(tree) !== undefined, 4);
if (panelShown === undefined) throw new Error('重新展开失败');
panelOf(panelShown).props.onMouseLeave();
const closedFromPanel = await until(reopen.renderAgain, (tree) => panelOf(tree) === undefined, 4, 200);
if (closedFromPanel === undefined) throw new Error('从面板左侧滑出时面板没有收起');
console.log('✓ 从面板左侧滑出：面板收起');

// 4e) 刷新按钮必须有可见反馈：点击后变「刷新中…」，完成后显示「更新于 HH:MM:SS」
const refreshRun = await mount({ usage: USAGE });
badgeOf(refreshRun.tree).props.onMouseEnter();
const refreshedPanelTree = await until(refreshRun.renderAgain, (tree) => panelOf(tree) !== undefined, 4);
if (refreshedPanelTree === undefined) throw new Error('展开失败（刷新用例）');
const findRefreshButton = (tree) =>
  findNode(tree, (node) => node?.type === 'button' && textOf(node).includes('刷新'));
const refreshButton = findRefreshButton(refreshedPanelTree);
if (refreshButton === undefined) throw new Error('面板里找不到刷新按钮');
// 已成功读过余额 → 应显示"更新于 HH:MM:SS"
if (!/更新于 \d{2}:\d{2}:\d{2}/.test(textOf(refreshedPanelTree))) {
  throw new Error(`面板应显示最近更新时间：${textOf(refreshedPanelTree)}`);
}
// 点击 → 立刻进入「刷新中…」且按钮 disabled
const readsBefore = balanceReads;
refreshButton.props.onClick();
const duringRefresh = await refreshRun.renderAgain();
const busyText = textOf(duringRefresh);
if (!busyText.includes('刷新中')) throw new Error(`点击后应显示「刷新中…」，实际：${busyText}`);
const busyButton = findRefreshButton(duringRefresh);
if (busyButton.props.disabled !== true) throw new Error('刷新中按钮应 disabled');
console.log('✓ 刷新按钮：点击后显示「刷新中…」并禁用');
// 请求完成后恢复并重新计时
const afterRefresh = await until(
  refreshRun.renderAgain,
  (tree) => textOf(tree).includes('刷新') && !textOf(tree).includes('刷新中'),
  5,
  60
);
if (afterRefresh === undefined) throw new Error('刷新完成后按钮未恢复');
if (balanceReads <= readsBefore) throw new Error('点击刷新后没有发起新的余额请求');
if (!/更新于 \d{2}:\d{2}:\d{2}/.test(textOf(afterRefresh))) throw new Error('刷新后未更新时间');
console.log(`✓ 刷新按钮：完成后恢复并更新时间（请求数 ${readsBefore} → ${balanceReads}）`);

// 4e-2) 「我刚充值了」按钮：点击后显示「查询中…」并禁用，查完恢复
{
  // 用一个**挂起**的赠金请求来稳定观察中间态：
  // 真实网络下这一步本来就要花时间，「查询中…」是能看到的；
  // mock 立即返回的话它会在同一批微任务里被收尾，观察不到。
  const markRun = await mount({ usage: USAGE, balance: 50 });
  badgeOf(markRun.tree).props.onMouseEnter();
  const opened = await until(markRun.renderAgain, (tree) => panelOf(tree) !== undefined, 4);
  if (opened === undefined) throw new Error('展开失败（充值按钮用例）');
  bonusMode = 'hang';
  const findMarkButton = (tree) =>
    findNode(tree, (node) => {
      if (node?.type !== 'button') return false;
      const t = textOf(node);
      return t.includes('充值') || t.includes('查询中');
    });
  const markButton = findMarkButton(opened);
  if (markButton === undefined) throw new Error('面板里找不到「我刚充值了」按钮');
  if (textOf(markButton) !== '我刚充值了') throw new Error(`按钮初始文案不符：${textOf(markButton)}`);

  markButton.props.onClick();
  const busyTree = await markRun.renderAgain();
  const busy = findMarkButton(busyTree);
  if (busy === undefined || !textOf(busy).includes('查询中')) {
    throw new Error(`点击后应显示「查询中…」，实际：${textOf(busyTree)}`);
  }
  if (busy.props.disabled !== true) throw new Error('查询中按钮应 disabled');
  console.log('✓ 「我刚充值了」：点击后显示「查询中…」并禁用');
}

// 4e-3) 赠金请求有响应后按钮恢复，且提示里带上印证金额
{
  const done = await mount({ usage: USAGE, balance: 50 });
  bonusPayload = [{ orderId: 'ord-1', amount: 5, currency: 'CNY', grantedAt: new Date().toISOString() }];
  badgeOf(done.tree).props.onMouseEnter();
  const opened3 = await until(done.renderAgain, (tree) => panelOf(tree) !== undefined, 4);
  const mark3 = findNode(opened3, (node) => {
    if (node?.type !== 'button') return false;
    const t = textOf(node);
    return t.includes('充值') || t.includes('查询中');
  });
  const bonusBefore = bonusesReads;
  mark3.props.onClick();
  const finished = await until(
    done.renderAgain,
    (tree) => {
      const button = findNode(tree, (node) => {
        if (node?.type !== 'button') return false;
        const t = textOf(node);
        return t.includes('充值') || t.includes('查询中');
      });
      return button !== undefined && textOf(button) === '我刚充值了' && textOf(tree).includes('官方赠金');
    },
    5,
    60
  );
  if (finished === undefined) {
    throw new Error(`查询完成后应恢复并显示赠金印证：${textOf(done.tree)}`);
  }
  if (bonusesReads <= bonusBefore) throw new Error('点击后没有查询赠金接口');
  console.log(`✓ 「我刚充值了」：查完恢复并带上「官方赠金 ¥5.00 印证」（赠金路由调用数 ${bonusBefore} → ${bonusesReads}）`);
}

// 4e) 点击折叠：只留角标；再点恢复
const foldRun = await mount({ usage: USAGE });
badgeOf(foldRun.tree).props.onClick();
const foldedTree = await foldRun.renderAgain();
const foldedText = textOf(foldedTree);
if (foldedText.includes('本会话')) throw new Error(`折叠后不应有「本会话」行：${foldedText}`);
if (!foldedText.includes('余')) throw new Error(`折叠角标应显示余额：${foldedText}`);
const foldedBadge = badgeOf(foldedTree);
if (foldedBadge.children.filter(Boolean).length !== 2) throw new Error('折叠态应是「标签 + 数值」两格');
console.log(`✓ 点击折叠：只剩角标（${foldedText.replace(/\s+/g, ' ').trim()}）`);
foldedBadge.props.onClick();
const unfolded = await foldRun.renderAgain();
if (!textOf(unfolded).includes('本会话')) throw new Error('再次点击未恢复展开');
console.log('✓ 再次点击：恢复展开');

// 4f) **充值不影响花费计数**（方案 B+C 的核心）：识别到充值只抬锚点，计数照常累计
//     这是用户原始诉求："只改变余额不改变花费，让花费正常运行"
{
  const topupRun = await mount({ usage: USAGE, balance: 43.42 });
  const { observeRead, readStore, sessionSpentOf, applyExternalChange, classifyRead } = topupRun.plugin.__test;
  const store0 = readStore();

  // 首次读数：定锚 43.42
  observeRead(SESSION_ACTIVE, 43.42, 0);
  // 消费 0.30（token 上界给 0.30，正常计入）
  observeRead(SESSION_ACTIVE, 43.12, 0.3);
  let spent = sessionSpentOf(readStore(), SESSION_ACTIVE);
  if (Math.abs(spent - 0.3) > 1e-9) throw new Error(`消费后应为 0.30，实际 ${spent}`);

  // **充值 50**：余额跳到 93.12
  const verdict = observeRead(SESSION_ACTIVE, 93.12, 0.05);
  if (verdict.kind !== 'topup') throw new Error(`应识别为充值，实际 ${verdict.kind}`);
  spent = sessionSpentOf(readStore(), SESSION_ACTIVE);
  if (Math.abs(spent - 0.3) > 1e-9) throw new Error(`充值不得改变花费计数，应为 0.30，实际 ${spent}`);
  console.log(`✓ 识别充值 ¥${verdict.amount.toFixed(2)}：余额抬起、花费计数仍是 ¥${spent.toFixed(2)}`);

  // 充值后继续消费 0.20 → 计数累加到 0.50（不再有"暂停"）
  observeRead(SESSION_ACTIVE, 92.92, 0.2);
  spent = sessionSpentOf(readStore(), SESSION_ACTIVE);
  if (Math.abs(spent - 0.5) > 1e-9) throw new Error(`充值后应继续累计到 0.50，实际 ${spent}`);
  console.log(`✓ 充值后花费继续正常运行：¥${spent.toFixed(2)}`);

  // 判据：token 上界足以覆盖的正常消费，不该被误判成充值
  if (classifyRead(43.12, 43.0, 0.5).kind !== 'spend') throw new Error('正常消费被误判');
  if (classifyRead(43.12, 43.2, 0.05).kind !== 'topup') throw new Error('超出 token 上界的升幅应判为充值');
  if (classifyRead(43.12, 43.13, 0.05).kind !== 'noise') throw new Error('容差内的噪声应忽略');
  console.log('✓ 判据：token 上界内的下降=消费，超出上界的上升=充值，容差内=忽略');

  // 手动兜底（方案 C）：同样只抬锚点、不动计数
  const beforeManual = sessionSpentOf(readStore(), SESSION_ACTIVE);
  applyExternalChange(100, 0, SESSION_ACTIVE, 'topup');
  const afterManual = sessionSpentOf(readStore(), SESSION_ACTIVE);
  if (Math.abs(beforeManual - afterManual) > 1e-9) throw new Error('手动标记不得改变计数');
  console.log(`✓ 手动兜底「我刚充值了」：计数保持 ¥${afterManual.toFixed(2)}`);
  void store0;
}

// 4g) 多会话：充值要把**所有**会话的锚点一起抬，否则别的会话会把充值当消费
{
  const multi = await mount({ usage: USAGE, balance: 50 });
  const { observeRead, readStore, sessionSpentOf, applyExternalChange } = multi.plugin.__test;
  observeRead(SESSION_ACTIVE, 50, 0);
  observeRead(SESSION_IDLE, 49.5, 0.5);
  observeRead(SESSION_ACTIVE, 49, 0.5);
  const aBefore = sessionSpentOf(readStore(), SESSION_ACTIVE);
  const bBefore = sessionSpentOf(readStore(), SESSION_IDLE);

  // 充值：99 → 所有锚点都必须抬到 99
  applyExternalChange(99, 49, SESSION_ACTIVE, 'topup');
  const st = readStore();
  for (const [id, entry] of Object.entries(st.sessions)) {
    if (Math.abs(entry.baseline - 99) > 1e-9) throw new Error(`${id} 的锚点未抬到 99：${entry.baseline}`);
  }
  if (Math.abs(sessionSpentOf(st, SESSION_ACTIVE) - aBefore) > 1e-9) throw new Error('A 计数被改动');
  if (Math.abs(sessionSpentOf(st, SESSION_IDLE) - bBefore) > 1e-9) throw new Error('B 计数被改动');
  console.log(`✓ 充值同时抬所有会话锚点：A ¥${aBefore.toFixed(2)} / B ¥${bBefore.toFixed(2)} 各自不变`);
}

// 4h) 本会话分摊：**累计花费** × 本会话 token / 全会话 token
//     分子是计数器（充值不影响它），不是"锚点 − 余额"。
//     这里直接复算卡片用的那个表达式（客户端已不再注入 apportionedDelta，避免两份口径）。
{
  const share = await mount({ usage: USAGE, balance: 20 });
  const { observeRead } = share.plugin.__test;
  observeRead(SESSION_ACTIVE, 20, 0);
  observeRead(SESSION_ACTIVE, 19, 1); // 计数 = 1.00
  const spent = share.plugin.__test.sessionSpentOf(share.plugin.__test.readStore(), SESSION_ACTIVE);
  if (Math.abs(spent - 1) > 1e-9) throw new Error(`计数应为 1.00：${spent}`);
  const own = 0.6;
  const other = 0.2;
  const got = spent * (own / (own + other));
  if (Math.abs(got - 0.75) > 1e-9) throw new Error(`分摊应为 0.75，实际 ${got}`);
  console.log(`✓ 分摊基于累计计数：¥${spent.toFixed(2)} × 75% = ¥${got.toFixed(2)}`);
}

const anon = await mount({ usage: USAGE, mode: 'unavailable' });
expectIncludes('未登录（路由返回 unavailable）', textOf(anon.tree), ['余额', '未登录']);
const failed = await mount({ usage: USAGE, mode: 'error' });
expectIncludes('Platform 拒绝（error 状态）', textOf(failed.tree), ['余额', '读取失败']);
for (const [mode, label] of [['unreachable', '路由不可达'], ['http500', 'HTTP 500'], ['badjson', '非 JSON'], ['badshape', '未知形状']]) {
  const broken = await mount({ usage: USAGE, mode });
  expectIncludes(`路由异常（${label}）`, textOf(broken.tree), ['余额', '读取失败']);
}
const pending = await mount({ usage: USAGE, mode: 'hang' });
expectIncludes('首读未返回 → 读取中', textOf(pending.tree), ['余额', '读取中']);

// 6) 纯函数：readBalance 的三态映射
const { readBalance, formatCost, formatCostShort, formatMoney } = normal.plugin.__test;
const callWith = async (mode) => {
  const previous = balanceMode;
  balanceMode = mode;
  installFetchMock();
  try {
    return await readBalance();
  } finally {
    // 恢复模式：这几个用例会临时改成 error/unreachable，
    // 不恢复的话后续新挂载的组件会继承成失败态。
    balanceMode = previous;
    installFetchMock();
  }
};
const parsedReady = await callWith('ready');
if (parsedReady.kind !== 'ready' || Math.abs(parsedReady.total - 43.4213) > 1e-9) {
  throw new Error(`ready 解析错误：${JSON.stringify(parsedReady)}`);
}
console.log(`✓ ready 解析：normal+bonus = ¥${parsedReady.total.toFixed(4)}（${parsedReady.currency}）`);
for (const [mode, kind] of [['unavailable', 'unavailable'], ['error', 'error'], ['http500', 'error'], ['badjson', 'error'], ['badshape', 'error'], ['unreachable', 'error']]) {
  const parsed = await callWith(mode);
  if (parsed.kind !== kind) throw new Error(`${mode} 应映射为 ${kind}，实际 ${JSON.stringify(parsed)}`);
}
console.log('✓ 三态映射：ready / unavailable / error（HTTP 500、非 JSON、未知形状、不可达）');

// 7) 无用量会话 / 无框架 share 回落
const blank = await mount({ usage: undefined });
expectIncludes('无用量会话', textOf(blank.tree), ['余额', '¥43.42', '本会话', '—']);
const fallback = await mount({ usage: USAGE, withSessionsShare: false });
expectIncludes('无框架 share 的回落路径', textOf(fallback.tree), ['余额', '¥43.42']);

// 8) 基线表（v4）：按会话存锚点 + **累计花费计数**，外部变动只移锚点不改计数
//    · 跨刷新存活、切走切回不清零、**切换会话不损坏记录**
//    · v3 / v2 / v1 老数据自动迁移
//    · 过期与超量淘汰、无 localStorage 降级
const { readStore, loadTracker, createTracker, checkoutSession, observeRead, applyExternalChange, accountLevelDelta, sessionSpentOf } = normal.plugin.__test;
const storage = installStorageMock();
const KEY = 'dsh-balance-hud:tracker:v4';
const sessionA = SESSION_ACTIVE;
const sessionB = SESSION_IDLE;
/** 取当前基线表。 */
const store = () => readStore();

// 8-0) **持久化必须无损**：每次切换会话都会走 checkoutSession，
//      它绝不能抹掉 lastRead（抹掉的话，下次读数退化成用锚点当"上次读数"，
//      真实消费会被整段吞掉）。这是"有损重建记录"那个 bug 的回归用例。
{
  storage.clear();
  observeRead(sessionA, 43.42, 0);
  observeRead(sessionA, 43.12, 0.3);
  const before = store().sessions[sessionA];
  if (typeof before.lastRead !== 'number') throw new Error(`读后应写入 lastRead：${JSON.stringify(before)}`);

  // 模拟"切走再切回"：checkoutSession 会被调用
  checkoutSession(sessionA, 43.12);
  const after = store().sessions[sessionA];
  for (const key of ['baseline', 'lastRead', 'lastBalance', 'spent']) {
    if (after[key] !== before[key]) {
      throw new Error(`checkoutSession 破坏了 ${key}：${before[key]} → ${after[key]}`);
    }
  }
  // 再切一次（余额未知的情况）
  checkoutSession(sessionA, null);
  const after2 = store().sessions[sessionA];
  if (after2.lastRead !== before.lastRead || after2.lastBalance !== before.lastBalance) {
    throw new Error(`重复 checkoutSession 破坏了记录：${JSON.stringify(after2)}`);
  }
  console.log('✓ checkoutSession 无损：lastRead / lastBalance / spent 都不被抹掉');

  // 记录里不应出现值为 undefined 的字段（JSON 序列化会把它悄悄删掉）
  const raw = storage.getItem(KEY);
  if (raw.includes('undefined')) throw new Error(`持久化内容里出现了 undefined：${raw}`);
  console.log('✓ 持久化内容不含 undefined 字段');
}

// 8-0) **赠金时效性**：过期回收不可计入花费
//      赠金到期会被平台收回，表现为余额凭空下降却没有对应消费。
//      判据与充值对称：降幅超过 token 估算上界 → 外部减钱，只下移锚点、不动计数。
{
  const { classifyRead } = normal.plugin.__test;

  // 纯判据
  if (classifyRead(43.0, 38.0, 0.5).kind !== 'expire') {
    throw new Error(`降幅远超 token 上界应判为 expire：${JSON.stringify(classifyRead(43.0, 38.0, 0.5))}`);
  }
  if (classifyRead(43.0, 42.5, 0.5).kind !== 'spend') {
    throw new Error(`降幅在上界内仍应算消费：${JSON.stringify(classifyRead(43.0, 42.5, 0.5))}`);
  }
  // 边界：降幅正好等于上界 → 仍算消费（不能把正常消费误判成回收）
  if (classifyRead(43.0, 42.5, 0.5).kind !== 'spend') {
    throw new Error('降幅等于上界时应算消费');
  }
  console.log('✓ 赠金过期判据：降幅 > token 上界 → expire，否则仍算消费');

  // 记账：过期不加计数、只下移锚点，之后继续正常累计
  storage.clear();
  observeRead(sessionA, 43.0, 0); // 定锚 43.00
  observeRead(sessionA, 42.4, 0.6); // 正常消费 0.60
  const beforeExpire = sessionSpentOf(store(), sessionA);
  if (Math.abs(beforeExpire - 0.6) > 1e-9) throw new Error(`消费后应为 0.60：${beforeExpire}`);

  // 5 元赠金过期：43 → 37.4，期间 token 估值只有 0.1
  const verdict = observeRead(sessionA, 37.4, 0.1);
  if (verdict.kind !== 'expire') throw new Error(`应识别为过期回收：${verdict.kind}`);
  const afterExpire = sessionSpentOf(store(), sessionA);
  if (Math.abs(afterExpire - beforeExpire) > 1e-9) {
    throw new Error(`过期回收绝不能改变花费计数：${beforeExpire} → ${afterExpire}`);
  }
  if (Math.abs(store().sessions[sessionA].baseline - 37.4) > 1e-9) {
    throw new Error(`过期后锚点应下移到 37.4：${store().sessions[sessionA].baseline}`);
  }
  console.log(`✓ 赠金过期 ¥5.00：计数保持 ¥${afterExpire.toFixed(2)}，锚点下移到 ¥37.40`);

  // 过期之后继续消费，仍要正常累计
  observeRead(sessionA, 37.0, 0.4);
  const afterResume = sessionSpentOf(store(), sessionA);
  if (Math.abs(afterResume - 1.0) > 1e-9) {
    throw new Error(`过期后应继续累计到 1.00：${afterResume}`);
  }
  console.log(`✓ 过期后花费继续累计：¥${afterResume.toFixed(2)}`);

  // 过期要把**所有**会话的锚点一起下移（余额是账户级的），且各会话计数都不变。
  // 用一个真实的共享余额序列，这样也能顺带钉住"previous 取哪一次读数"的正确性：
  // A 读过 44 之后，B 再读 43 必须和**B 自己的**上次读数（48.5）比，
  // 而不是和 A 刚写下的全局读数（44）比 —— 后者会把 B 这 5.5 元的真实消费算丢。
  storage.clear();
  observeRead(sessionA, 50, 0); // A 定锚 50
  observeRead(sessionB, 48.5, 1.5); // B 首读，定锚 48.5
  observeRead(sessionB, 48.5, 1.5); // B 自己的"上次读数"落定
  const bBefore = sessionSpentOf(store(), sessionB);

  observeRead(sessionA, 44, 0.1); // 大幅下降且超出 token 上界 → expire
  const aAfterExpire = sessionSpentOf(store(), sessionA);

  // 所有会话的锚点同步下移到 44
  for (const [id, entry] of Object.entries(store().sessions)) {
    if (Math.abs(entry.baseline - 44) > 1e-9) throw new Error(`${id} 的锚点未下移到 44：${entry.baseline}`);
  }
  if (Math.abs(aAfterExpire) > 1e-9) throw new Error(`A 的计数被过期改动了：${aAfterExpire}`);

  // B 的真实现金流：48.5 → 43.0。上界必须 ≥ 实际消费额，否则按判据会被当成外部减钱 ——
  // 现实中这 5.5 元正是对应 token 花掉的，所以上界取 5.5（对应它这段时间的 token 成本）。
  observeRead(sessionB, 43, 5.5);
  const bAfter = sessionSpentOf(store(), sessionB);
  if (Math.abs(bAfter - (bBefore + 5.5)) > 1e-9) {
    throw new Error(`B 应累计到 ${(bBefore + 5.5).toFixed(2)}（上次读数 48.5 → 43），实际 ${bAfter}`);
  }
  console.log(
    `✓ 过期下移所有锚点（A 计数 ¥${aAfterExpire.toFixed(2)} 不变）；B 仍按自己的上次读数累计到 ¥${bAfter.toFixed(2)}`
  );
}


storage.clear();
observeRead(sessionA, 50, 0);
if (Math.abs(store().sessions[sessionA].baseline - 50) > 1e-9) throw new Error(`A 未定锚：${JSON.stringify(store())}`);
observeRead(sessionA, 49.2, 0.8);
if (Math.abs(sessionSpentOf(store(), sessionA) - 0.8) > 1e-9) {
  throw new Error(`A 的计数应为 0.8：${sessionSpentOf(store(), sessionA)}`);
}
// 模拟刷新：从磁盘重读，计数仍在
if (Math.abs(sessionSpentOf(store(), sessionA) - 0.8) > 1e-9) throw new Error('刷新后计数丢失');
console.log('✓ 定锚 + 累计消费 0.8，刷新后存活');

// 8b) 同一个"消费"不重复计入：余额没继续降时再读一次，计数不变
observeRead(sessionA, 49.2, 0.5);
if (Math.abs(sessionSpentOf(store(), sessionA) - 0.8) > 1e-9) {
  throw new Error(`余额未变时不该重复累计：${sessionSpentOf(store(), sessionA)}`);
}
console.log('✓ 余额未变时重复读数不会重复累计');

// 8c) 会话 B 独立计数（锚点跟着会话走，不串号）
storage.clear();
observeRead(sessionA, 50, 0);
observeRead(sessionB, 49.5, 0.5);
observeRead(sessionB, 49.0, 0.5);
const spentA = sessionSpentOf(store(), sessionA);
const spentB = sessionSpentOf(store(), sessionB);
if (Math.abs(spentA - spentB) > 1e-9 && Math.abs(spentA) > 1e-9) {
  throw new Error(`A/B 计数异常：A=${spentA} B=${spentB}`);
}
if (Math.abs(store().sessions[sessionA].baseline - 50) > 1e-9) {
  throw new Error(`A 的锚点应保持 50：${store().sessions[sessionA].baseline}`);
}
console.log(`✓ 按会话分别累计：A ¥${spentA.toFixed(2)} / B ¥${spentB.toFixed(2)}（锚点不串号）`);

// 8d) 充值：只抬锚点，计数不动；充值后继续正常累计
storage.clear();
observeRead(sessionA, 50, 0);
observeRead(sessionA, 49, 1);
const beforeTopup = sessionSpentOf(store(), sessionA);
const v = observeRead(sessionA, 199, 0.1);
if (v.kind !== 'topup') throw new Error(`应识别充值：${v.kind}`);
if (Math.abs(sessionSpentOf(store(), sessionA) - beforeTopup) > 1e-9) {
  throw new Error(`充值改变了计数：${sessionSpentOf(store(), sessionA)}`);
}
observeRead(sessionA, 198, 1);
const afterTopup = sessionSpentOf(store(), sessionA);
if (Math.abs(afterTopup - (beforeTopup + 1)) > 1e-9) {
  throw new Error(`充值后应继续累计：${afterTopup}`);
}
console.log(`✓ 充值只改余额：计数 ¥${beforeTopup.toFixed(2)} → ¥${afterTopup.toFixed(2)}（继续正常累计）`);

// 8e) 账户级参照 = 各会话计数之和
const total = accountLevelDelta(store());
if (typeof total !== 'number' || total <= 0) throw new Error(`账户级参照异常：${total}`);
console.log(`✓ 账户级参照（各会话计数之和）= ¥${total.toFixed(2)}`);

// 8f) v3 迁移
storage.clear();
storage.setItem('dsh-balance-hud:tracker:v3', JSON.stringify({ sessions: { 'sess-v3': { baseline: 30, start: 30, ts: Date.now() } } }));
if (Math.abs(store().sessions['sess-v3'].baseline - 30) > 1e-9) throw new Error(`v3 未迁移：${JSON.stringify(store())}`);
if (storage.getItem('dsh-balance-hud:tracker:v3') !== null) throw new Error('迁移后应删除 v3 键');
console.log('✓ v3 自动迁移到 v4');

// 8g) v2 扁平字典迁移
storage.clear();
storage.setItem('dsh-balance-hud:tracker:v2', JSON.stringify({ 'sess-v2': { baseline: 20, start: 20, ts: Date.now() } }));
if (Math.abs(store().sessions['sess-v2'].baseline - 20) > 1e-9) throw new Error('v2 未迁移');
console.log('✓ v2 自动迁移到 v4');

// 8h) v1 单条迁移
storage.clear();
storage.setItem('dsh-balance-hud:tracker:v1', JSON.stringify({ sessionId: 'sess-v1', baseline: 12.5, start: 12.5, ts: Date.now() }));
if (Math.abs(store().sessions['sess-v1'].baseline - 12.5) > 1e-9) throw new Error('v1 未迁移');
console.log('✓ v1 自动迁移到 v4');

// 8i) 过期与超量淘汰
storage.clear();
storage.setItem(
  KEY,
  JSON.stringify({
    sessions: {
      stale: { baseline: 1, spent: 0, ts: Date.now() - 40 * 24 * 3600 * 1000 },
      fresh: { baseline: 2, spent: 0, ts: Date.now() }
    }
  })
);
observeRead('another', 1, 0);
if (store().sessions.stale !== undefined) throw new Error('过期锚点应被淘汰');
if (store().sessions.fresh === undefined) throw new Error('未过期的不应被误删');
console.log('✓ 过期锚点（>30 天）被淘汰');

storage.clear();
const many = {};
for (let i = 0; i < 40; i += 1) many[`s${i}`] = { baseline: i, spent: 0, ts: Date.now() - i * 1000 };
storage.setItem(KEY, JSON.stringify({ sessions: many }));
observeRead('s0b', 0, 0);
const kept = Object.keys(store().sessions).length;
if (kept > 30) throw new Error(`应只保留最近 30 个：${kept}`);
console.log(`✓ 超量淘汰：保留最近 ${kept} 个会话`);

// 8j) localStorage 不可用 → 降级仅内存
const savedStorage = globalThis.localStorage;
globalThis.localStorage = undefined;
observeRead(sessionA, 10, 0);
if (sessionSpentOf(store(), sessionA) !== null) throw new Error('无 localStorage 时应为空表');
globalThis.localStorage = savedStorage;
console.log('✓ localStorage 不可用时降级为仅内存');

// 9) 页面可见性联动：回到前台立刻补读
const visRun = await mount({ usage: USAGE }, 3);
if (visRun.doc.listenerCount() !== 1) {
  throw new Error(`应注册 1 个 visibilitychange 监听，实际 ${visRun.doc.listenerCount()}`);
}
const before = balanceReads;
visRun.doc.setHidden(true);
visRun.doc.setHidden(false);
await settle();
await settle();
if (balanceReads <= before) throw new Error('回到前台后未立刻补读余额');
console.log(`✓ 可见性联动：回前台立刻补读（${before} → ${balanceReads}）`);

// 10) A1 设置：配置容器、收敛、持久化
{
  const {
    defaultSettings, normalizeSettings, loadSettings, saveSettings,
    createSettingsStore, settingsKey
  } = normal.plugin.__test;
  // 用"当前"的替身：前面每次 mount 都会重装一个，早先那个变量可能已被丢弃。
  const settingsStorage = installStorageMock();

  // 默认值
  const base = defaultSettings();
  if (base.model !== 'deepseek-flash' || base.pollSeconds !== 60) {
    throw new Error(`默认配置不符：${JSON.stringify(base)}`);
  }
  console.log('✓ 设置：默认配置（flash / 60s / 未设预算）');

  // 脏数据必须被收敛，而不是让 HUD 崩掉
  const dirty = normalizeSettings({
    model: 'gpt-5',                 // 非法模型 → 回落
    pollSeconds: 999999,            // 非法间隔 → 回落
    hiddenPollSeconds: -1,
    showAccountTotal: 'yes',        // 非布尔 → 回落
    sessionBudget: -5,              // 负数 → 回落
    dailyBudget: 'abc',
    peakWarnMinutes: 7,             // 不在选项里 → 回落
    notifyPeak: true
  });
  if (dirty.model !== 'deepseek-flash') throw new Error(`非法模型未收敛：${dirty.model}`);
  if (dirty.pollSeconds !== 60) throw new Error(`非法间隔未收敛：${dirty.pollSeconds}`);
  if (dirty.showAccountTotal !== true) throw new Error('非布尔未收敛');
  if (dirty.sessionBudget !== 0) throw new Error(`负预算未收敛：${dirty.sessionBudget}`);
  if (dirty.peakWarnMinutes !== 10) throw new Error(`非法提前量未收敛：${dirty.peakWarnMinutes}`);
  if (dirty.notifyPeak !== true) throw new Error('合法值被误改');
  console.log('✓ 设置：脏数据逐字段收敛，合法值不动');

  // 持久化 + 订阅
  saveSettings({ model: 'deepseek-v4-pro', pollSeconds: 30 });
  const reloaded = loadSettings();
  if (reloaded.model !== 'deepseek-v4-pro' || reloaded.pollSeconds !== 30) {
    throw new Error(`持久化失败：${JSON.stringify(reloaded)}`);
  }
  if (!settingsStorage.getItem(settingsKey)) throw new Error('配置未落盘');
  console.log('✓ 设置：落盘并读回');

  // 容器：set 会广播，且两处（设置行 / 浮层）看到同一份
  const store2 = createSettingsStore();
  let seen = 0;
  const unsub = store2.subscribe(() => { seen += 1; });
  store2.set({ sessionBudget: 12.5 });
  if (seen !== 1) throw new Error(`订阅未触发：${seen}`);
  if (store2.get().sessionBudget !== 12.5) throw new Error('容器未更新');
  // 部分合并：只改一个字段，其它保留
  if (store2.get().model !== 'deepseek-v4-pro') throw new Error('set 覆盖了无关字段');
  unsub();
  store2.set({ sessionBudget: 1 });
  if (seen !== 1) throw new Error('取消订阅后仍触发');
  console.log('✓ 设置：容器广播 + 部分合并 + 可取消订阅');

  // 损坏的 JSON 不能让插件崩
  settingsStorage.setItem(settingsKey, '{ not json');
  if (loadSettings().pollSeconds !== 60) throw new Error('损坏配置未回落默认');
  console.log('✓ 设置：配置损坏时回落默认（不抛错）');
}

// 11) A2 预算：分档与最严重级别
{
  const { evaluateBudget, worstBudgetLevel } = normal.plugin.__test;
  if (evaluateBudget(1, 0).level !== 'none') throw new Error('未设预算应为 none');
  if (evaluateBudget(1, 10).level !== 'none') throw new Error('10% 不该告警');
  if (evaluateBudget(7.5, 10).level !== 'warn') throw new Error('75% 应为 warn');
  if (evaluateBudget(9, 10).level !== 'critical') throw new Error('90% 应为 critical');
  if (evaluateBudget(12, 10).level !== 'over') throw new Error('超限应为 over');
  const over = evaluateBudget(12, 10);
  if (over.remaining !== 0) throw new Error(`超限后剩余应夹到 0：${over.remaining}`);
  if (Math.abs(evaluateBudget(3, 10).remaining - 7) > 1e-9) throw new Error('剩余额算错');
  console.log('✓ 预算：75% warn / 90% critical / 超限 over，剩余夹到 0');

  if (worstBudgetLevel(['none', 'warn', 'critical']) !== 'critical') throw new Error('未取最严重');
  if (worstBudgetLevel(['over', 'none']) !== 'over') throw new Error('over 应最严重');
  if (worstBudgetLevel(['none', 'none']) !== 'none') throw new Error('全 none 应 none');
  console.log('✓ 预算：两条预算取最严重的一条');
}

// 12) A2 每日台账：跨天归零、只吃确认值
{
  const { addDailySpent, loadDaily, beijingDateKey, dailyKey } = normal.plugin.__test;
  const dailyStorage = installStorageMock();
  if (loadDaily().total !== 0) throw new Error('初始应为 0');
  const t1 = addDailySpent(1.5);
  const t2 = addDailySpent(0.5);
  if (Math.abs(t1 - 1.5) > 1e-9 || Math.abs(t2 - 2) > 1e-9) throw new Error(`累计错：${t1} / ${t2}`);
  // 0 或负数不累计
  if (Math.abs(addDailySpent(0) - 2) > 1e-9) throw new Error('0 不该累计');
  if (Math.abs(addDailySpent(-3) - 2) > 1e-9) throw new Error('负数不该累计');
  console.log('✓ 每日台账：累加确认花费，0/负数忽略');

  // 跨天：把手上的日期改成昨天，读的时候必须归零
  const stale = JSON.parse(dailyStorage.getItem(dailyKey));
  dailyStorage.setItem(dailyKey, JSON.stringify({ date: '2000-01-01', total: 99 }));
  const after = loadDaily();
  if (after.total !== 0) throw new Error(`跨天未归零：${after.total}`);
  if (after.date !== beijingDateKey(new Date())) throw new Error('跨天后日期未更新');
  void stale;
  console.log('✓ 每日台账：跨天自动归零');

  // 损坏内容不抛
  dailyStorage.setItem(dailyKey, 'oops');
  if (loadDaily().total !== 0) throw new Error('损坏台账未回落');
  console.log('✓ 每日台账：内容损坏时回落 0');
}

// 13) A3 峰谷：切换倒计时与提醒窗口
{
  const { minutesUntilTierChange } = normal.plugin.__test;
  // 北京时间 = UTC+8。用固定 UTC 时刻构造，避免依赖本机时区。
  const bj = (y, m, d, hh, mm) => new Date(Date.UTC(y, m - 1, d, hh - 8, mm));
  const checks = [
    // 周一 08:50 北京时间 → 10 分钟后进入峰时
    [bj(2026, 1, 5, 8, 50), 'peak', 10],
    // 周一 09:30 → 峰时中，150 分钟后回闲时（到 12:00）
    [bj(2026, 1, 5, 9, 30), 'off', 150],
    // 周一 12:30 → 90 分钟后进入峰时（14:00）
    [bj(2026, 1, 5, 12, 30), 'peak', 90],
    // 周一 17:50 → 10 分钟后回闲时
    [bj(2026, 1, 5, 17, 50), 'off', 10],
    // 周五 18:30 → 下一个峰时是周一 09:00（14.5 小时 = 870 分钟）
    [bj(2026, 1, 9, 18, 30), 'peak', 870],
    // 周六 12:00 → 周一 09:00
    [bj(2026, 1, 10, 12, 0), 'peak', 45 * 60]
  ];
  for (const [when, to, minutes] of checks) {
    const got = minutesUntilTierChange(when);
    if (got.to !== to || got.minutes !== minutes) {
      throw new Error(
        `峰谷倒计时不符：${when.toISOString()} 期望 ${to}/${minutes}，实际 ${got.to}/${got.minutes}`
      );
    }
  }
  console.log('✓ 峰谷：峰前/峰后/跨午休/跨周末的倒计时都对');
}

// 14) 价格同步：解析官方页面、合并来源、缓存与"默认不外联"
{
  const {
    parsePricingPage, resolvePrices, loadPriceCache, savePriceCache,
    PRICES_CACHE_KEY, DEFAULT_SYNC_HOURS, SYNC_INTERVAL_HOURS,
    normalizeSettings, defaultSettings, costOf
  } = normal.plugin.__test;

  // 14a) 用**真实抓取的官方表格**做固定用例。
  //      官方改版会让测试先红，而不是等用户发现价格算错。
  const fixturePath = path.join(here, 'fixtures', 'pricing-table.html');
  const fixture = fs.readFileSync(fixturePath, 'utf8');
  const parsed = parsePricingPage(fixture);
  if (parsed === null) throw new Error('官方价格表固定用例解析失败（页面结构可能已改版）');
  const expectPrices = {
    'deepseek-flash': { cacheHit: [0.02, 0.04], cacheMiss: [1, 2], output: [4, 8] },
    'deepseek-v4-pro': { cacheHit: [0.15, 0.3], cacheMiss: [4.5, 9], output: [13.5, 27] }
  };
  for (const [id, expected] of Object.entries(expectPrices)) {
    const got = parsed.models[id];
    if (got === undefined) throw new Error(`固定用例里缺少模型 ${id}`);
    for (const kind of ['cacheHit', 'cacheMiss', 'output']) {
      if (Math.abs(got[kind].off - expected[kind][0]) > 1e-9 || Math.abs(got[kind].peak - expected[kind][1]) > 1e-9) {
        throw new Error(`${id}.${kind} 解析不符：${JSON.stringify(got[kind])} 期望 ${JSON.stringify(expected[kind])}`);
      }
    }
  }
  console.log('✓ 价格解析：真实官方表格固定用例，两模型六项价全部对上');

  // 14b) 编码无关：整份 UTF-8 被按 Latin-1 解码后仍要能解析。
  //      这是真实抓取链路上会发生的退化（中文标签全变乱码）。
  const misDecoded = Buffer.from(fixture, 'utf8').toString('latin1');
  const parsedMojibake = parsePricingPage(misDecoded);
  if (parsedMojibake === null) throw new Error('乱码页面应仍可解析（判据必须与中文无关）');
  if (Math.abs(parsedMojibake.models['deepseek-flash'].cacheHit.peak - 0.04) > 1e-9) {
    throw new Error(`乱码页面解析出的价格不对：${JSON.stringify(parsedMojibake.models['deepseek-flash'])}`);
  }
  console.log('✓ 价格解析：编码无关（UTF-8 被误按 Latin-1 解码也能解析）');

  // 14c) 结构损坏必须**整条放弃**，而不是给半张表
  for (const [label, broken] of [
    ['空文本', ''],
    ['没有表格', '<html><body>no table</body></html>'],
    ['只有表头', '<table><tr><td>x</td><td>deepseek-a</td><td>deepseek-b</td></tr></table>']
  ]) {
    if (parsePricingPage(broken) !== null) throw new Error(`${label} 应解析失败`);
  }
  // 档位配反（峰时价低于闲时价）必须被语义校验拒绝
  const inverted = fixture.replace(/0\.04/g, '0.01').replace(/0\.30/g, '0.01');
  const invertedResult = parsePricingPage(inverted);
  if (invertedResult !== null) {
    const flash = invertedResult.models['deepseek-flash'];
    if (flash?.cacheHit?.peak <= flash?.cacheHit?.off) throw new Error('峰时价低于闲时价时应拒绝解析');
  }
  console.log('✓ 价格解析：结构损坏或档位反常时放弃（不用半张表算钱）');

  // 14d) 合并来源：同步优先，但内置表里没被同步到的模型要保留
  const merged = resolvePrices({
    models: { 'deepseek-flash': { cacheHit: { off: 1, peak: 2 }, cacheMiss: { off: 1, peak: 2 }, output: { off: 1, peak: 2 } } },
    capturedAt: '2026-01-01T00:00:00.000Z'
  });
  if (merged.source !== 'synced') throw new Error(`应标记为 synced：${merged.source}`);
  if (merged.prices['deepseek-flash'].cacheHit.peak !== 2) throw new Error('同步值未生效');
  if (merged.prices['deepseek-v4-pro'] === undefined) throw new Error('内置表里其它模型应保留');
  if (resolvePrices(null).source !== 'builtin') throw new Error('无同步时应标记 builtin');
  console.log('✓ 价格来源：同步优先、未同步的模型保留内置价、来源可分辨');

  // 14e) costOf 会用传入的价格表
  const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const byBuiltin = costOf(usage, 'deepseek-flash', false).total;
  const bySynced = costOf(usage, 'deepseek-flash', false, merged.prices).total;
  if (Math.abs(byBuiltin - 1) > 1e-9) throw new Error(`内置表单价应为 1：${byBuiltin}`);
  if (Math.abs(bySynced - 1) > 1e-9) throw new Error(`同步表单价应为 1：${bySynced}`);
  console.log('✓ 计价：costOf 使用传入的价格表');

  // 14f) 缓存往返
  const cacheStorage = installStorageMock();
  const saved = {
    models: { 'deepseek-flash': { cacheHit: { off: 0.02, peak: 0.04 }, cacheMiss: { off: 1, peak: 2 }, output: { off: 4, peak: 8 } } },
    capturedAt: '2026-09-29T00:00:00.000Z',
    etag: '"abc"',
    lastModified: 'x',
    source: 'synced'
  };
  savePriceCache(saved);
  const reloaded = loadPriceCache();
  if (reloaded?.etag !== '"abc"' || reloaded?.capturedAt !== saved.capturedAt) {
    throw new Error(`价格缓存往返失败：${JSON.stringify(reloaded)}`);
  }
  if (cacheStorage.getItem(PRICES_CACHE_KEY) === null) throw new Error('价格缓存未落盘');
  cacheStorage.setItem(PRICES_CACHE_KEY, 'not json');
  if (loadPriceCache() !== null) throw new Error('损坏的缓存应返回 null');
  console.log('✓ 价格缓存：往返保留条件请求头与抓取时间，损坏时安全回落');

  // 14g) **默认零外联**：新用户默认不自动同步
  const defaults = defaultSettings();
  if (defaults.syncHours !== 0) throw new Error(`自动同步应默认关闭：${defaults.syncHours}`);
  if (!SYNC_INTERVAL_HOURS.includes(DEFAULT_SYNC_HOURS)) throw new Error('默认间隔必须在选项里');
  if (DEFAULT_SYNC_HOURS !== 24) throw new Error(`默认间隔应为 24 小时：${DEFAULT_SYNC_HOURS}`);
  if (normalizeSettings({ syncHours: 999 }).syncHours !== 0) throw new Error('非法间隔应收敛为关闭');
  if (normalizeSettings({ syncHours: 24 }).syncHours !== 24) throw new Error('合法间隔应保留');
  console.log('✓ 价格同步：默认关闭（零外联），非法间隔收敛为关闭，24 小时为默认档');
}

// 15) 模型对齐：按会话实际使用的模型计价
{
  const { sessionModelOf, sessionModelsUsed, normalizeSettings, defaultSettings, costOf } =
    normal.plugin.__test;

  // 15a) 三种来源的优先级：requestContext > requestHeader > 最后一条助手消息
  const withAll = {
    requestContext: () => ({ provider: 'p', model: 'deepseek-v4-pro' }),
    requestHeader: () => ({ config: { model: 'deepseek-flash' } }),
    deriveMessages: () => [{ source: { model: 'deepseek-flash' } }]
  };
  if (sessionModelOf(withAll) !== 'deepseek-v4-pro') {
    throw new Error(`应优先取 requestContext：${sessionModelOf(withAll)}`);
  }
  const withoutContext = {
    requestContext: () => undefined,
    requestHeader: () => ({ config: { model: 'deepseek-v4-pro' } }),
    deriveMessages: () => [{ source: { model: 'deepseek-flash' } }]
  };
  if (sessionModelOf(withoutContext) !== 'deepseek-v4-pro') {
    throw new Error(`应回落到 requestHeader：${sessionModelOf(withoutContext)}`);
  }
  const onlyMessages = {
    requestContext: () => undefined,
    requestHeader: () => undefined,
    deriveMessages: () => [{ source: { model: 'deepseek-flash' } }, { source: { model: 'deepseek-v4-pro' } }]
  };
  if (sessionModelOf(onlyMessages) !== 'deepseek-v4-pro') {
    throw new Error(`应取最后一条助手消息的模型：${sessionModelOf(onlyMessages)}`);
  }
  console.log('✓ 模型对齐：requestContext → requestHeader → 最后一条助手消息，逐级回落');

  // 15b) 接口全挂掉 / 全空 时要返回 undefined（让调用方回落用户设置），不能抛错
  const hostile = {
    requestContext: () => { throw new Error('boom'); },
    requestHeader: () => { throw new Error('boom'); },
    deriveMessages: () => { throw new Error('boom'); }
  };
  if (sessionModelOf(hostile) !== undefined) throw new Error('接口抛错时应返回 undefined');
  const empty = { requestContext: () => ({ model: '' }), requestHeader: () => undefined, deriveMessages: () => [] };
  if (sessionModelOf(empty) !== undefined) throw new Error('拿不到模型时应返回 undefined');
  if (sessionModelOf(undefined) !== undefined) throw new Error('无会话时应返回 undefined');
  console.log('✓ 模型对齐：接口异常或为空时安全回落（不抛错、不猜）');

  // 15c) 混用多个模型要能被识别出来（用于如实标注"这是估算"）
  const mixed = {
    deriveMessages: () => [
      { source: { model: 'deepseek-flash' } },
      { source: { model: 'deepseek-v4-pro' } },
      { source: { model: 'deepseek-flash' } }
    ]
  };
  const used = sessionModelsUsed(mixed);
  if (used.length !== 2 || used[0] !== 'deepseek-flash' || used[1] !== 'deepseek-v4-pro') {
    throw new Error(`混用模型识别不对：${JSON.stringify(used)}`);
  }
  if (sessionModelsUsed({ deriveMessages: () => [{ role: 'user' }] }).length !== 0) {
    throw new Error('没有模型痕迹时应返回空数组');
  }
  console.log('✓ 模型对齐：识别会话混用过多个模型（用于标注估算而非精确值）');

  // 15d) 对齐真的会改钱：同一份用量按两个模型算出来的价必须不同
  const usage = { uncachedInputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 };
  const flash = costOf(usage, 'deepseek-flash', false).total;
  const pro = costOf(usage, 'deepseek-v4-pro', false).total;
  if (Math.abs(flash - 1) > 1e-9) throw new Error(`flash 未命中输入应为 1：${flash}`);
  if (Math.abs(pro - 4.5) > 1e-9) throw new Error(`pro 未命中输入应为 4.5：${pro}`);
  if (flash === pro) throw new Error('两个模型的价不该相同');
  console.log(`✓ 模型对齐：同一用量下 flash ¥${flash} ≠ pro ¥${pro}（选错模型确实会算错钱）`);

  // 15e) 默认跟随会话，且该开关必须逐字段收敛
  if (defaultSettings().modelFollowsSession !== true) throw new Error('默认应跟随会话模型');
  if (normalizeSettings({ modelFollowsSession: 'yes' }).modelFollowsSession !== true) {
    throw new Error('非布尔应回落到默认 true');
  }
  if (normalizeSettings({ modelFollowsSession: false }).modelFollowsSession !== false) {
    throw new Error('显式 false 应保留');
  }
  console.log('✓ 模型对齐：默认跟随会话，非法值逐字段收敛');
}

console.log('\n全部冒烟测试通过');
// 组件里的轮询定时器会吊住事件循环，显式退出。
process.exit(0);
//#endregion
