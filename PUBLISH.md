# 开源发布步骤（GitHub）

这份文档是给仓库维护者自己的操作手册。**仓库建好、推上去之后就可以删掉它**，
或者留在仓库里也无妨。

> 前置：已安装 Git（`winget install --id Git.Git -e --source winget`），
> 装完要**重开一个终端**，PATH 才会刷新。

---

## 1. 设置 Git 身份（只需一次）

提交记录会**永久**带上这个信息，用你愿意公开的名字和邮箱：

```powershell
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱"
```

不想暴露真实邮箱的话，用 GitHub 提供的匿名地址：
`GitHub → Settings → Emails → Keep my email addresses private`，
页面会给出形如 `12345678+你的用户名@users.noreply.github.com` 的地址。

验证：

```powershell
git config --global --list
```

---

## 2. 首次提交

仓库已经初始化好了（`git init -b main` 已执行、文件已暂存）。
只剩身份设置好之后执行：

```powershell
cd <本仓库所在目录>          # 例如 ...\_plugin_build\dsh-balance-hud
git status            # 确认 17 个文件，且没有 node_modules / .env
git commit -m "feat: initial release of dsh-balance-hud"
```

想反悔这次提交（还没推送时随时可以）：

```powershell
git reset --soft HEAD~1
```

---

## 3. 在 GitHub 建空仓库

打开 https://github.com/new

| 字段 | 填什么 | 为什么 |
| --- | --- | --- |
| Repository name | `dsh-balance-hud` | |
| Description | `Always-on account balance & session cost HUD for DSH (DeepSeek Harness)` | 显示在仓库标题下，也被搜索引擎收录 |
| Visibility | **Public** | 开源必须 Public；Private 只能自己看 |
| Add a README file | **不勾** | 勾了会多一次提交，和本地历史冲突（要 `--allow-unrelated-histories` 硬合） |
| Add .gitignore | **不勾** | 仓库里已有 |
| Choose a license | **不勾** | 仓库里已有 MIT |

---

## 4. 关联远端并推送

把 `<你的用户名>` 换成你的 GitHub 用户名：

```powershell
git remote add origin https://github.com/<你的用户名>/dsh-balance-hud.git
git push -u origin main
```

第一次推送会**弹出浏览器让你授权**（Git Credential Manager）。
登录 GitHub、点允许即可，之后同一台机器不用再登。

此后日常推送只要：

```powershell
git push
```

---

## 5. 补仓库元信息

仓库页面右上角 **⚙️ About**：

- **Description**：同上
- **Topics**（标签，帮助别人搜到）：
  `dsh` `dsh-plugin` `deepseek` `balance` `cost-tracking` `hud` `localStorage`

---

## 6. 打第一个版本标签（可选但推荐）

```powershell
git tag -a v0.1.0 -m "first public release"
git push origin v0.1.0
```

然后到 GitHub 的 **Releases → Draft a new release**，选择 `v0.1.0`，写发布说明。
有 Release 的项目更容易被信任。

---

## 7. 日常开发流程

```powershell
git status                      # 看改了什么
git add lib/client.js           # 只添加你确认的改动（别用 git add -A 盲加）
git commit -m "fix: 修正分摊分母"
git push
```

**推送前一定跑一遍测试**：

```powershell
node tools/smoke.mjs
node tools/verify-install.mjs --package
```

---

## 8. 发布前自查清单

- [ ] `git status` 里没有 `node_modules/`、`.env`、临时文件、编辑器目录
- [ ] 全仓库搜过一遍密钥（见下）
- [ ] `node tools/smoke.mjs` 退出码 0（47 条断言）
- [ ] `node tools/verify-install.mjs --package` 退出码 0
- [ ] README 顶部的语言切换链接指向真实存在的文件
- [ ] 仓库里没有绝对路径泄漏用户名

搜索密钥：

```powershell
git grep -nEi "api[_-]?key|secret|password|bearer|authorization|sk-[A-Za-z0-9]{10,}|ghp_|github_pat_|AKIA[0-9A-Z]{10,}"
```

以及搜自己的用户名 / 绝对路径：

```powershell
# 把 <你的用户名> 换成你的账户名
git grep -nEi "<你的用户名>|C:\\\\Users|/home/" -- .
```

---

## 9. 常见问题

**`git: command not found`**
刚装完 Git 需要重开终端；或直接用全路径
`& "$env:ProgramFiles\Git\cmd\git.exe" --version`。

**推送被拒：`failed to push some refs`**
远端有你本地没有的提交（通常是建仓时勾了 README）。要么先拉后合：

```powershell
git pull --rebase origin main
git push
```

要么重建一个空的远端仓库。

**每次推送都要输密码**
说明凭据没存住。执行一次 `git config --global credential.helper manager`，
再推一次让它重新走授权。

**想换远端地址**

```powershell
git remote set-url origin https://github.com/<新用户名>/<新仓库>.git
```

**不小心提交了敏感信息**
删文件**不够**，历史里还在。最稳妥是用
[git-filter-repo](https://github.com/newren/git-filter-repo) 重写历史，
或者**直接删掉远端仓库重建**（小项目更快也更干净）。同时把已泄漏的密钥作废。

---

## 10. 这个项目的特殊注意点

- **改客户端半边**（`lib/client.js`）只需刷新页面。
- **改 Host 半边**（`lib/index.js`，例如那条赠金路由）需要**重启 DSH**，
  因为 profile bundles 不热加载。Pull request 里请说明你验证过。
- **行尾是 LF**，由 `.gitattributes` 强制。不要为了"本地看起来舒服"去改 `core.autocrlf`。
- **不要引入构建步骤或运行时依赖** —— 这个插件刻意零依赖，
  `lib/client.js` 就是 DSH 直接加载的成品。
