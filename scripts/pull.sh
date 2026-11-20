#!/bin/sh
# 把一份反馈取回本地看：scripts/pull.sh <编号>，或 scripts/pull.sh --list [YYYY-MM-DD]
# 要两个环境变量：FEEDBACK_URL（如 https://<域名>/feedback）和 FEEDBACK_ADMIN_TOKEN。都不写在仓库里。
set -eu
: "${FEEDBACK_URL:?先设 FEEDBACK_URL}"
: "${FEEDBACK_ADMIN_TOKEN:?先设 FEEDBACK_ADMIN_TOKEN}"
if [ "${1:-}" = "--list" ]; then
  curl -fsS -H "Authorization: Bearer $FEEDBACK_ADMIN_TOKEN" "$FEEDBACK_URL${2:+?day=$2}"
  echo
  exit 0
fi
id="${1:?用法：scripts/pull.sh <编号> | --list [日期]}"
mkdir -p "downloads/$id"
curl -fsS -H "Authorization: Bearer $FEEDBACK_ADMIN_TOKEN" -o "downloads/$id/bundle.zip" "$FEEDBACK_URL/$id"
# 包来自匿名用户：只解压到它自己的空文件夹里，当数据看，不执行里面的任何东西
unzip -q -o "downloads/$id/bundle.zip" -d "downloads/$id"
echo "downloads/$id"
