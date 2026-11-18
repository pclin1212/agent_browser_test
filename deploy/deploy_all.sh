#!/usr/bin/env bash
# 一键批量管理全部五个站点（封装 deploy.sh，端口为各站推荐组合）
#
# 用法（在仓库根目录执行）：
#   ./deploy/deploy_all.sh            # 等同 start：后台拉起全部五站
#   ./deploy/deploy_all.sh start      # 后台拉起全部
#   ./deploy/deploy_all.sh stop       # 停止全部
#   ./deploy/deploy_all.sh status     # 查看全部运行状态
#   ./deploy/deploy_all.sh restart    # 重启全部
#
# 站点与端口（固定推荐组合，与 cases/*.json 中的 base_url 一致）：
#   mail 8000 / shopping 8010 / forum 8020 / admin 8030 / gitlab 8040

set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)

SITES=(
  "8000 mail"
  "8010 shopping"
  "8020 forum"
  "8030 admin"
  "8040 gitlab"
)

# 一次批量启动的五站共享同一产物目录 output/deploy_<时间戳>/（stop/status 无需此变量）
DEPLOY_OUT_DIR="$HERE/../output/deploy_$(date +%Y%m%d-%H%M%S)"
export DEPLOY_OUT_DIR

ACTION="${1:-start}"
case "$ACTION" in
  start|stop|status) ;;
  restart)
    "$0" stop || true
    "$0" start
    exit 0
    ;;
  *)
    echo "用法：$0 [start|stop|status|restart]（默认 start）" >&2
    exit 1
    ;;
esac

FAIL=0
for entry in "${SITES[@]}"; do
  read -r port site <<< "$entry"
  echo "=== $site (127.0.0.1:$port) ==="
  if ! "$HERE/deploy.sh" "$ACTION" "$port" "$site"; then
    echo "^^ $site $ACTION 失败" >&2
    FAIL=1
  fi
done

if [ "$FAIL" -ne 0 ]; then
  echo "存在失败项，请检查上方输出" >&2
fi
exit $FAIL
