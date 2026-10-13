#!/bin/sh
# ---------------------------------------------------------------------------
# 安装启动器（macOS / Linux）：找到 Node 之后把 tools/install.mjs 跑起来。
#
# 为什么需要它：README 里的 `node tools/install.mjs` 假定 Node 在 PATH 上，
# 但 DSH 用户不一定装过 Node —— DSH 自带一份运行时，却不在 PATH 里。
#
# 查找顺序：DSH_NODE → node（PATH）→ DSH 自带 → 常见安装位置（含 Homebrew / nvm）。
#
# 用法：sh tools/install.sh [--profile <目录>] [--uninstall] [--dry-run]
# ---------------------------------------------------------------------------
set -eu

SCRIPT_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
TARGET="$SCRIPT_DIR/install.mjs"

find_node() {
  if [ -n "${DSH_NODE:-}" ] && [ -x "${DSH_NODE}" ]; then
    printf '%s' "$DSH_NODE"
    return 0
  fi
  if command -v node >/dev/null 2>&1; then
    command -v node
    return 0
  fi
  dsh_home="${DSH_HOME:-$HOME/.dsh}"
  for candidate in "$dsh_home"/dsh-runtimes/*/dependencies/node/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  for candidate in \
    /opt/homebrew/bin/node \
    /usr/local/bin/node \
    /usr/bin/node \
    "$HOME/.nvm/versions/node"/*/bin/node \
    "$HOME/.volta/bin/node" \
    "$HOME/.local/share/fnm/node-versions"/*/installation/bin/node; do
    if [ -x "$candidate" ]; then
      printf '%s' "$candidate"
      return 0
    fi
  done
  return 1
}

if NODE=$(find_node); then
  echo "用这个 Node：$NODE"
  exec "$NODE" "$TARGET" "$@"
fi

cat >&2 <<'MSG'

  没有找到 Node.js，装不了。

  三种解决办法，任选一种：
    1. 装 Node.js 18 以上：https://nodejs.org/
    2. 直接指定路径：DSH_NODE=/path/to/node sh tools/install.sh
    3. DSH 装在非默认位置时：DSH_HOME=/path/to/.dsh sh tools/install.sh

MSG
exit 1
