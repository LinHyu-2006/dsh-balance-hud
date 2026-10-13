/**
 * 打发布 tag 并推送。
 *
 * 本脚本**不创建 GitHub Release**：那需要一次 HTTP 写操作，而写操作要么用
 * Personal Access Token（长期凭据，得用户去网页生成并保管），要么走 GitHub App。
 * 用户已配好的 SSH 密钥只能用于 git 传输，换不到 API 写权限。
 *
 * 所以这里只做到"tag 推上去"，Release 的正交方法在最后打印出来。
 *
 * 用法：node tools/release.mjs --tag v1.0.0 [--dry-run]
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { packageRoot, nodeBin } from './_env.mjs';

const argv = process.argv.slice(2);
const dryRun = argv.includes('--dry-run');
const tagIndex = argv.indexOf('--tag');
const tag = tagIndex >= 0 ? argv[tagIndex + 1] : undefined;

if (!tag) {
  console.error('用法：node tools/release.mjs --tag v1.0.0 [--dry-run]');
  process.exit(1);
}
if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
  console.error(`tag 必须形如 v1.2.3：${tag}`);
  process.exit(1);
}

const pkg = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
if (`v${pkg.version}` !== tag) {
  console.error(`package.json 版本是 ${pkg.version}，与 tag ${tag} 不一致。先改版本再打 tag。`);
  process.exit(1);
}

const git = (args) =>
  execFileSync('git', ['-C', packageRoot, ...args], { encoding: 'utf8' }).trim();

console.log(`包版本：${pkg.version}`);
console.log(`当前提交：${git(['rev-parse', '--short', 'HEAD'])}`);
console.log(`工作区：${git(['status', '--short']) === '' ? '干净' : '有未提交改动'}`);

const existing = git(['tag', '-l', tag]);
if (existing === tag) {
  console.log(`tag ${tag} 已存在，跳过创建`);
} else if (dryRun) {
  console.log(`[dry-run] 会创建附注 tag：git tag -a ${tag} -m "..."`);
} else {
  git(['tag', '-a', tag, '-m', `Release ${tag}`]);
  console.log(`✓ 已创建 tag ${tag}`);
}

if (git(['status', '--short']) !== '') {
  console.log('\n⚠ 工作区有未提交改动，push 前请先提交。');
}

if (dryRun) {
  console.log(`\n[dry-run] 之后会：git push origin ${tag}`);
  process.exit(0);
}

git(['push', 'origin', 'main']);
git(['push', 'origin', tag]);
console.log(`✓ 已推送 main 与 ${tag}`);

console.log(`
下一步（需要你自己做，因为要一次凭据）：
  在 GitHub 上创建 Release 并在正文里概括本次变更：
  https://github.com/LinHyu-2006/dsh-balance-hud/releases/new?tag=${tag}

  或者生成一个只对这一个仓库、只有 Contents: Read and write 权限的细粒度令牌，
  然后我可以改用 API 创建 Release：
  https://github.com/settings/tokens?type=beta
`);
void nodeBin;
