/**
 * 把本插件安装到某个 DSH profile。
 *
 * 用法：
 *   node tools/install.mjs [--profile <dir>] [--uninstall] [--dry-run]
 *
 * 做的事：
 *   1. 备份 profile 的 package.json（仅首次，`.bak-balance-hud`）
 *   2. 在 `dependencies` 里加 `"dsh-balance-hud": "file:<本仓库路径>"`
 *   3. 在 `dsh.profile.bundles` 末尾加 `"dsh-balance-hud"`
 *   4. 建立 `node_modules/dsh-balance-hud` 链接（pnpm 装过就用它的，否则自建）
 *   5. 跑一遍安装校验
 *
 * 注意：**改了 Host 半边或增删整个插件后需要重启 DSH**（bundles 不热加载）；
 * 只改客户端 bundle 的话刷新页面即可。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { packageRoot, requireProfileDir, nodeBin } from './_env.mjs';

const BUNDLE = 'dsh-balance-hud';
const dryRun = process.argv.includes('--dry-run');
const uninstall = process.argv.includes('--uninstall');
const log = (message) => console.log(`${dryRun ? '[dry-run] ' : ''}${message}`);

const profileDir = requireProfileDir();
const manifestPath = path.join(profileDir, 'package.json');
const installDir = path.join(profileDir, 'plugins', BUNDLE);
const linkDir = path.join(profileDir, 'node_modules', BUNDLE);

if (!fs.existsSync(manifestPath)) {
  throw new Error(`profile 里没有 package.json：${manifestPath}`);
}

/**
 * 读 JSON 并容忍 BOM —— profile 的 package.json 如果带 BOM，
 * 插件管理器会以 `Unexpected token '\ufeff'` 直接失败。
 * @param file - 文件路径。
 * @returns 解析后的对象。
 */
function readJsonTolerant(file) {
  const raw = fs.readFileSync(file, 'utf8');
  return JSON.parse(raw.replace(/^\uFEFF/, ''));
}

/** 本插件的清单：发布清单 `files` 与 `dsh` 声明都从它读。 */
const ownPackage = readJsonTolerant(path.join(packageRoot, 'package.json'));

/**
 * 写 JSON，**不带 BOM**。
 * @param file - 文件路径。
 * @param value - 要写入的对象。
 */
function writeJsonNoBom(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8' });
}

const manifest = readJsonTolerant(manifestPath);
const hadBom = fs.readFileSync(manifestPath, 'utf8').startsWith('\uFEFF');

// ── 备份（只在首次） ────────────────────────────────────────────────────────
const backupPath = `${manifestPath}.bak-balance-hud`;
if (!dryRun && !fs.existsSync(backupPath)) {
  fs.copyFileSync(manifestPath, backupPath);
  log(`已备份 profile 清单 → ${path.basename(backupPath)}`);
}

if (uninstall) {
  // ── 卸载：摘掉清单条目 + 删链接与目录 ────────────────────────────────────
  if (manifest.dependencies) {
    delete manifest.dependencies[BUNDLE];
    log('从 dependencies 移除');
  }
  if (Array.isArray(manifest.dsh?.profile?.bundles)) {
    const before = manifest.dsh.profile.bundles.length;
    manifest.dsh.profile.bundles = manifest.dsh.profile.bundles.filter((name) => name !== BUNDLE);
    if (manifest.dsh.profile.bundles.length < before) log('从 dsh.profile.bundles 移除');
  }
  if (!dryRun) {
    writeJsonNoBom(manifestPath, manifest);
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.rmSync(installDir, { recursive: true, force: true });
    log('已删除 node_modules 链接与插件目录');
  }
  log('卸载完成，请重启 DSH。');
  process.exit(0);
}

// ── 安装 ────────────────────────────────────────────────────────────────────
// 依赖指向 profile 内的**副本**（`file:./plugins/<name>`），而不是仓库的绝对路径：
// 这样 profile 自包含，仓库可以随便移/删，DSH 启动也不依赖仓库还在。
// 代价是改了源码要重跑本脚本（它就是更新通道）。
const spec = `file:./plugins/${BUNDLE}`;
manifest.dependencies = manifest.dependencies ?? {};
manifest.dependencies[BUNDLE] = spec;
manifest.dsh = manifest.dsh ?? {};
manifest.dsh.profile = manifest.dsh.profile ?? {};
manifest.dsh.profile.bundles = Array.isArray(manifest.dsh.profile.bundles)
  ? manifest.dsh.profile.bundles
  : [];
if (!manifest.dsh.profile.bundles.includes(BUNDLE)) manifest.dsh.profile.bundles.push(BUNDLE);
log(`dependencies["${BUNDLE}"] = ${spec}`);
log(`dsh.profile.bundles += ${BUNDLE}`);

if (hadBom) log('检测到 profile 清单带 BOM —— 已改写为不带 BOM 的版本（否则插件管理器会报错）');

if (!dryRun) {
  writeJsonNoBom(manifestPath, manifest);

  // 把源码复制到 profile 的 plugins/ 下（客户端 bundle 走 /plugins 路由，
  // 必须真的在 profile 目录里，不能只靠 node_modules 链接）。
  //
  // 复制清单**从 package.json 的 `files` 派生**，不再手写：
  // 手写清单会和发布清单漂移（新增一个要发布的文件时，npm 里有、本地安装里没有），
  // 那种不一致只在用户那边才暴露。`files` 是 npm 的语义，所以顺带保证
  // "本地能装"和"发包能装"看到的是同一批文件。
  // 本地安装清单优先读 `installFiles`，没有才回落到 npm 的 `files`。
  // 两者分开的原因：`files` 是"发包要带的东西"，里面可以有 README 用的图片；
  // 而 profile 只需要运行时真正要加载的文件，多复制图片是纯粹的浪费。
  const source = Array.isArray(ownPackage.installFiles) ? ownPackage.installFiles : ownPackage.files;
  const publishList = Array.isArray(source) ? source : [];
  const toCopy = [];
  for (const entry of publishList) {
    const abs = path.join(packageRoot, entry);
    if (!fs.existsSync(abs)) continue;
    if (fs.statSync(abs).isDirectory()) {
      for (const name of fs.readdirSync(abs)) {
        const inner = path.join(abs, name);
        if (fs.statSync(inner).isFile()) toCopy.push(path.join(entry, name));
      }
    } else {
      toCopy.push(entry);
    }
  }
  // package.json 永远要复制（profile 靠它认插件），即使没写进 `files`
  for (const rel of ['package.json', ...toCopy]) {
    const from = path.join(packageRoot, rel);
    if (!fs.existsSync(from)) continue;
    const target = path.join(installDir, rel);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(from, target);
    log(`复制 ${rel}`);
  }

  // 建 node_modules 链接。pnpm 对 `file:` 依赖按内容缓存，
  // 目录被删掉后会误报 "Already up to date" 而不重建，所以这里自己保证链接存在。
  const linkOk = (() => {
    try {
      return fs.realpathSync(linkDir) === fs.realpathSync(installDir);
    } catch {
      return false;
    }
  })();
  if (linkOk) {
    log('node_modules 链接已正确');
  } else {
    fs.rmSync(linkDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(linkDir), { recursive: true });
    if (process.platform === 'win32') {
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          `New-Item -ItemType Junction -Path '${linkDir}' -Target '${installDir}' | Out-Null`
        ],
        { stdio: 'inherit' }
      );
    } else {
      fs.symlinkSync(installDir, linkDir, 'dir');
    }
    log('已建立 node_modules 链接');
  }
}

// ── 校验 ────────────────────────────────────────────────────────────────────
if (!dryRun) {
  log('校验安装结果 …\n');
  const output = execFileSync(nodeBin, [path.join(packageRoot, 'tools', 'verify-install.mjs'), '--profile', profileDir], {
    encoding: 'utf8'
  });
  process.stdout.write(output);
}

log(`\n完成。profile：${profileDir}`);
log('客户端改动 → 刷新页面即可；Host 改动或新增/移除插件 → 需要重启 DSH。');
void os;
