#!/usr/bin/env bash
# 一键把榜单仓库推送到 GitHub
#
# 用法：
#   ./deploy.sh https://github.com/<用户名>/<仓库名>.git
#
# 前置：先在 GitHub 上建好一个空仓库（不要勾选 README / .gitignore / License）

set -euo pipefail

cd "$(dirname "$0")"

REPO_URL="${1:-}"

if [ -z "$REPO_URL" ]; then
  echo "用法: ./deploy.sh https://github.com/<用户名>/<仓库名>.git"
  echo "     （也可以在网页上复制仓库地址，支持 SSH 形式 git@github.com:...）"
  exit 1
fi

# 1. 检查 Git 身份
NAME="$(git config --global user.name || true)"
EMAIL="$(git config --global user.email || true)"

if [ -z "$NAME" ] || [ -z "$EMAIL" ]; then
  echo "还没有设置 Git 身份，请先执行这两条（把内容换成你自己的）："
  echo
  echo '  git config --global user.name "你的名字"'
  echo '  git config --global user.email "你的邮箱@example.com"'
  echo
  echo "设置完再重新运行本脚本。"
  exit 1
fi

echo "Git 身份: $NAME <$EMAIL>"

# 2. 初始化仓库
if [ ! -d .git ]; then
  git init -q
  echo "已初始化本地仓库"
fi

# 3. 暂存并提交
git add -A

if git diff --staged --quiet; then
  echo "没有需要提交的变更"
else
  git commit -q -m "feat: init GitHub trending board"
  echo "已提交 $(git diff --staged --name-only HEAD~0 2>/dev/null | wc -l) 个文件"
fi

# 4. 切到 main 分支
git branch -M main

# 5. 配置远程
if git remote | grep -qx origin; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi
echo "远程地址: $REPO_URL"

# 6. 推送
echo
echo "开始推送（首次会弹窗要求登录 GitHub）..."
git push -u origin main

echo
echo "================================================"
echo " 推送完成！接下来还有两步（在网页上操作）："
echo "================================================"
echo
echo " 1) Settings → Pages → Source: Deploy from a branch"
echo "    分支选 main，目录选 / (root)，Save"
echo
echo " 2) Settings → Actions → General → Workflow permissions"
echo "    选 Read and write permissions，Save"
echo "    （不设置这一步，定时任务无法把数据提交回来）"
echo
echo " 然后在 Actions 标签页手动 Run 一次工作流，约 30 秒后数据生成。"
echo
echo " 访问地址：https://<用户名>.github.io/<仓库名>/"
