# GitHub Trending 自动更新榜单

一个部署在 **GitHub Pages** 上的开源项目趋势榜，每天自动抓取 GitHub Trending 的日榜 / 周榜 / 月榜并自动部署。

纯静态、零依赖、无需服务器、无需数据库，全部跑在 GitHub 免费额度内。

---

## 为什么需要 Actions

GitHub Pages 只能托管静态文件，**浏览器端直接 `fetch('https://github.com/trending')` 会被 CORS 拦掉**，而且 GitHub 也没有官方的 Trending API。

所以架构是这样：

```
GitHub Actions（每小时 cron）
        │
        ├─ node scripts/fetch-trending.mjs
        │     抓取 github.com/trending?since=daily|weekly|monthly
        │     解析 HTML → data/*.json
        │
        ├─ git commit & push 回仓库
        │
        └─ Pages 检测到 push → 自动重新构建
                │
                └─ index.html 读取 data/*.json 渲染
```

一句话：**Actions 负责"生成数据"，Pages 负责"展示数据"**。

---

## 部署步骤

### 1. 新建仓库并上传

先在 GitHub 上新建一个 **public** 空仓库（私有仓库用 Pages 需要 Pro）。

> 建仓库时**不要**勾选 "Add a README file" / ".gitignore" / "License"，保持完全空白，否则推送时会冲突。

#### 方式 A：一条命令（推荐）

在终端里进入本目录，运行：

```bash
./deploy.sh https://github.com/<你的用户名>/<仓库名>.git
```

脚本会自动完成初始化、提交、设置远程、推送，并打印后续两步操作。首次运行如果提示没有 Git 身份，按提示设置即可：

```bash
git config --global user.name  "你的名字"
git config --global user.email "你的邮箱@example.com"
```

#### 方式 B：手动敲命令

```bash
git init
git add .
git commit -m "feat: init trending board"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

#### 方式 C：网页上传（不用装 Git）

把本目录的文件拖到仓库首页的上传区域。**但 `.github` 是隐藏文件夹，容易漏掉**，两个解决办法：

- **先把隐藏项显示出来**：Windows 资源管理器 → 查看 → 显示 → 勾选「隐藏的项目」，然后整个文件夹拖进去；
- **或者单独创建这个文件**：仓库页 → `Add file` → `Create new file` → 文件名输入 `.github/workflows/update.yml`（输入 `/` 会自动创建目录）→ 把本地文件内容粘贴进去 → Commit。

> 漏掉 workflow 文件的话，页面能打开，但数据永远不会自动更新。


### 2. 开启 Pages

仓库 → **Settings** → **Pages** → Source 选 **Deploy from a branch** → 分支选 `main`，目录选 `/ (root)` → Save。

### 3. 允许 Actions 写仓库

仓库 → **Settings** → **Actions** → **General** → 底部 **Workflow permissions** → 选 **Read and write permissions** → Save。

> 这一步不能省。默认的只读权限会导致 `git push` 失败。

### 4. 手动跑一次

仓库 → **Actions** 标签 → 左侧 `Update GitHub Trending data` → 右侧 **Run workflow**。

大约 30 秒后 `data/` 目录会更新出 `daily.json` / `weekly.json` / `monthly.json` 三个文件。

### 5. 访问

```
https://<你的用户名>.github.io/<仓库名>/
```

首次部署 Pages 需要 1~2 分钟生效。

---

## 文件说明

| 路径 | 作用 |
|---|---|
| `index.html` | 前端页面，读取 `data/*.json` 渲染表格，含日/周/月切换 |
| `deploy.sh` | 一键推送脚本 |
| `scripts/fetch-trending.mjs` | 抓取 + 解析脚本，零依赖（Node 18+ 原生 fetch） |
| `.github/workflows/update.yml` | 定时任务，每小时第 7 分钟跑一次 |
| `test/parse.test.mjs` | 解析逻辑单元测试，`node test/parse.test.mjs` 运行 |
| `data/daily.json` | 日榜数据（自动生成） |
| `data/weekly.json` | 周榜数据（自动生成） |
| `data/monthly.json` | 月榜数据（自动生成） |
| `data/meta.json` | 最后更新时间 |

### 数据格式

```json
{
  "since": "daily",
  "generatedAt": "2026-10-25T03:44:00.000Z",
  "source": "https://github.com/trending?since=daily",
  "count": 10,
  "items": [
    {
      "rank": 1,
      "repo": "cloudflare/security-audit-skill",
      "url": "https://github.com/cloudflare/security-audit-skill",
      "description": "A coding-agent skill for multi-phase security audits...",
      "language": "JavaScript",
      "stars": 44858,
      "forks": 2782,
      "gained": 2264
    }
  ]
}
```

---

## 改起来

**换抓取频率** —— 改 `.github/workflows/update.yml` 里的 cron（注意是 **UTC**）：

```yaml
- cron: '7 * * * *'      # 每小时（当前）
- cron: '7 */6 * * *'    # 每 6 小时
- cron: '7 0 * * *'      # 每天 UTC 0 点 = 北京时间早 8 点
```

**只抓日榜** —— 改 workflow 里的命令：

```yaml
run: node scripts/fetch-trending.mjs --only=daily
```

**改成某个语言的榜单** —— 改脚本里的 URL：

```js
const url = `https://github.com/trending/python?since=${since}`;
```

**给描述加中文翻译** —— 在 workflow 里加一步，调 LLM API 把 `description` 翻一遍再写回 JSON。需要把 API Key 存进 **Settings → Secrets and variables → Actions**，然后在 workflow 里用 `${{ secrets.XXX }}` 引用。注意别把 Key 写进代码。

**换配色** —— `index.html` 顶部的 `:root` 里改 CSS 变量即可。

---

## 几个坑，提前说

1. **cron 不准时。** GitHub 的定时任务在整点高峰期会排队，实测延迟 5~20 分钟很常见。对榜单来说无所谓，但别拿它做准点任务。

2. **仓库会被"冻结"。** public 仓库如果 60 天没有任何提交，定时任务会被自动禁用。本方案每小时都在 commit，天然不会触发；但如果你改成低频（比如每周一次），要注意这个限制。

3. **抓取靠 DOM 结构。** `fetch-trending.mjs` 的解析逻辑依赖 GitHub Trending 页面当前的 HTML 结构。GitHub 改版就可能失效——脚本做了防御：**解析出 0 条会直接抛错并让 job 失败**，你会收到 Actions 失败邮件，而不是悄无声息地写入空数据。真失效了，改 `parseArticle()` 里的几个正则就行。

4. **频率别太高。** 每小时一次已经足够，再密容易被 GitHub 限流。脚本内置了 3 次重试和超时保护。

5. **免费额度。** public 仓库的 Actions 分钟数不计量，Pages 每月 100GB 带宽、软上限每小时 10 次构建。当前方案每小时 1 次构建，完全够用。

---

## 许可

MIT
