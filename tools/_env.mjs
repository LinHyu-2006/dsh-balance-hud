/**
 * 工具脚本共用的环境解析 —— 不写死任何绝对路径。
 *
 * profile 目录的优先级：
 *   1. 命令行 `--profile <dir>`
 *   2. 环境变量 `DSH_PROFILE_DIR`
 *   3. `~/.dsh/profiles/desktop`
 *
 * Node 可执行文件优先级：
 *   1. 环境变量 `DSH_NODE`
 *   2. 当前进程的 `process.execPath`（自己就是 Node，直接用）
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根目录（`tools/` 的上一级）。 */
export const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** 本次运行的 Node 可执行文件。 */
export const nodeBin = process.env.DSH_NODE ?? process.execPath;

/**
 * 读命令行里的 `--profile <dir>`。
 * @param argv - 参数数组。
 * @returns 目录，没传则 undefined。
 */
function profileFromArgv(argv) {
  const index = argv.indexOf('--profile');
  if (index === -1) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error('--profile 后面需要跟一个目录');
  return value;
}

/**
 * 解析 profile 目录（不校验存在性）。
 * @param argv - 参数数组，默认 `process.argv`。
 * @returns 绝对路径。
 */
export function resolveProfileDir(argv = process.argv) {
  const fromArgv = profileFromArgv(argv);
  if (fromArgv) return path.resolve(fromArgv);
  if (process.env.DSH_PROFILE_DIR) return path.resolve(process.env.DSH_PROFILE_DIR);
  return path.join(os.homedir(), '.dsh', 'profiles', 'desktop');
}

/**
 * 解析 profile 目录并确认它看起来像一个 DSH profile。
 * @param argv - 参数数组，默认 `process.argv`。
 * @returns 绝对路径。
 */
export function requireProfileDir(argv = process.argv) {
  const dir = resolveProfileDir(argv);
  if (!fs.existsSync(dir)) {
    throw new Error(
      `找不到 profile 目录：${dir}\n` +
        `用 --profile <dir> 或环境变量 DSH_PROFILE_DIR 指定，例如：\n` +
        `  node tools/verify-install.mjs --profile "$HOME/.dsh/profiles/desktop"`
    );
  }
  return dir;
}
