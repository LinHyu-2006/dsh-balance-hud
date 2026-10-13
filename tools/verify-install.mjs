/**
 * 校验安装结果：包可解析、两份入口可加载、客户端 bundle 形状正确。
 *
 * 两种模式：
 *   1. **安装校验**（默认）：`node tools/verify-install.mjs [--profile <dir>]`
 *      从 profile 的 node_modules 解析这个包，模拟 DSH 的加载方式。
 *   2. **离线自检**：`node tools/verify-install.mjs --package`
 *      不依赖任何 DSH 安装，直接校验仓库里的这份源码。
 *
 * 退出码 0 = 全部通过。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { packageRoot, requireProfileDir } from './_env.mjs';

const offline = process.argv.includes('--package');
const step = (label, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
};

// ── 1) 定位这个包 ───────────────────────────────────────────────────────────
let pkgPath;
let viaProfile = false;
if (offline) {
  pkgPath = path.join(packageRoot, 'package.json');
} else {
  const profileDir = requireProfileDir();
  const require = createRequire(path.join(profileDir, 'package.json'));
  try {
    pkgPath = require.resolve('dsh-balance-hud/package.json');
    viaProfile = true;
  } catch {
    // 解析不到就按约定路径找（pnpm 的 file: 依赖有时不会被 require 解析到）
    pkgPath = path.join(profileDir, 'node_modules', 'dsh-balance-hud', 'package.json');
  }
}
step(
  offline ? '在仓库里找到 package.json' : '包可从 profile 解析',
  fs.existsSync(pkgPath),
  pkgPath
);
const dir = path.dirname(pkgPath);
if (!offline) step('解析来源', true, viaProfile ? 'profile 的 node_modules' : '约定的插件目录');

const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
step('name 正确', pkg.name === 'dsh-balance-hud', pkg.name);
step('声明 dsh.bundle.patch', typeof pkg.dsh?.bundle?.patch === 'string', pkg.dsh?.bundle?.patch);
step('声明 dsh.client.platform = web', pkg.dsh?.client?.platform === 'web');
// `dsh.client.inject` 在 DSH 的 schema 里是**可选**的（只用于激活顺序的先验提示，
// 不参与规则判定）。所以这里只在"声明了"时要求它是字符串数组，
// 不声明也算通过 —— 早期这里是硬断言，导致删掉一个用不到的声明就误报失败。
step(
  'dsh.client.inject 若声明则必须是字符串数组',
  pkg.dsh?.client?.inject === undefined ||
    (Array.isArray(pkg.dsh.client.inject) && pkg.dsh.client.inject.every((n) => typeof n === 'string')),
  pkg.dsh?.client?.inject === undefined ? '(未声明，合法)' : undefined,
);

const patchPath = path.resolve(dir, pkg.dsh.bundle.patch);
step('patch 文件存在', fs.existsSync(patchPath), patchPath);
const patch = fs.readFileSync(patchPath, 'utf8');
step('patch 含 insert 行', /insert:/.test(patch) && patch.includes('dsh-balance-hud'));

const clientRel = pkg.exports['./client'];
const clientPath = path.join(dir, clientRel);
step('client bundle 存在', fs.existsSync(clientPath), `${clientPath} (${fs.statSync(clientPath).size} B)`);

// ── 2) 客户端 bundle 的加载形状（模拟 dsh-client-modules 在浏览器里注册它）──
const captured = [];
globalThis.window = { __ModuleLoader__: { load: (record) => captured.push(record) } };
const clientSource = fs.readFileSync(clientPath, 'utf8');
new Function('window', 'require', 'module', 'exports', clientSource)(
  globalThis.window,
  () => {
    throw new Error('客户端 bundle 在注册期不应 require 任何模块');
  },
  { exports: {} },
  {}
);
step('注册 1 条模块行', captured.length === 1);
step('模块 id = 包名', captured[0]?.id === 'dsh-balance-hud', captured[0]?.id);
step('factory 是函数', typeof captured[0]?.factory === 'function');

const reactStub = {
  createElement: () => null,
  useState: () => [undefined, () => {}],
  useEffect: () => {},
  useRef: (initial) => ({ current: typeof initial === 'function' ? initial() : initial }),
  Fragment: Symbol('Fragment')
};
const plugin = captured[0].factory((name) => {
  if (name === 'react') return reactStub;
  throw new Error(`bundle 请求了未列入 dsh.client.inject 的模块：${name}`);
});
step('导出 apply', typeof plugin.apply === 'function');
step('导出 inject 数组', Array.isArray(plugin.inject), JSON.stringify(plugin.inject));

// ── 3) Host 半边可被 Loader 导入 ────────────────────────────────────────────
const hostUrl = pathToFileURL(path.join(dir, 'lib/index.js')).href;
const host = await import(hostUrl);
step('host 入口可导入', true, hostUrl.split('/').slice(-2).join('/'));
step('host 导出 apply', typeof host.apply === 'function');
step('host 导出 name', host.name === 'balance-hud', host.name);
step('host 依赖声明完整', Array.isArray(host.inject) && host.inject.includes('deepseekAccount'), JSON.stringify(host.inject));

console.log(process.exitCode ? '\n校验未通过' : '\n校验通过');
