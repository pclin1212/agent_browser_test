#!/usr/bin/env bash
# 本地静态站点一键部署脚本（高并发后端）
#
# 用法（在仓库根目录执行）：
#   ./deploy/deploy.sh                          前台启动 mail-demo，默认端口 8000，Ctrl+C 停止
#   ./deploy/deploy.sh 8080                     前台启动 mail-demo，指定端口
#   ./deploy/deploy.sh start [port] [site]      后台启动（pid/log 写入 output/deploy/）
#   ./deploy/deploy.sh stop [port] [site]       停止后台服务（含端口兜底清理）
#   ./deploy/deploy.sh status [port] [site]     查看状态
#
# 站点（site）：
#   mail        仓库 html/（mail-demo 邮箱站，默认）
#   shopping    仓库 sites/mini-shopping/（推荐端口 8010）
#   forum       仓库 sites/mini-forum/（推荐端口 8020）
#   admin       仓库 sites/mini-admin/（推荐端口 8030）
#   gitlab      仓库 sites/mini-gitlab/（推荐端口 8040）
#   也可直接传站点目录的绝对/相对路径
#
# 静态服务根目录为对应站点目录（入口 index.html 所在目录）。
# 后端为内嵌调优的线程化 Python 服务器，专为压测 agent-browser 设计，
# 避免静态服务自身成为性能瓶颈：
#   - HTTP/1.1 keep-alive：连接复用，消除高并发下的 TCP churn
#   - 静默访问日志：去掉逐请求写日志的磁盘/锁开销
#   - listen backlog 512：默认值是 5，并发接入风暴下会丢 SYN
#   - TCP_NODELAY：小文件响应立即发出，降低延迟
#   - Cache-Control: no-store：每次请求真实回源，保证各轮压测数据可比
#
# 入口页面：http://127.0.0.1:<port>/index.html

set -euo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)

# 站点名 → 站点根目录
site_dir() {
  case "$1" in
    mail|"")      echo "$HERE/../html" ;;
    shopping)     echo "$HERE/../sites/mini-shopping" ;;
    forum)        echo "$HERE/../sites/mini-forum" ;;
    admin)        echo "$HERE/../sites/mini-admin" ;;
    gitlab)       echo "$HERE/../sites/mini-gitlab" ;;
    *)            echo "$1" ;;
  esac
}

SITE="${3:-mail}"
SITE_DIR="$(site_dir "$SITE")"
if [ ! -f "$SITE_DIR/index.html" ]; then
  echo "错误：站点目录 $SITE_DIR 不存在或缺少 index.html（site=$SITE）" >&2
  exit 1
fi
DOC_ROOT="$(cd "$SITE_DIR" && pwd)"
PORT="${2:-8000}"
# 运行产物（pid/log）统一收纳在仓库 output/ 下：
#   - start 每次自动创建独立目录 output/deploy_<时间戳>/（DEPLOY_OUT_DIR 可覆盖，
#     deploy_all.sh 用它让一次批量启动的五站共享同一目录）
#   - stop/status 跨所有 output/deploy_*/ 目录查找 pid（兼容旧版平铺 output/deploy/）
OUT_ROOT="$HERE/../output"
if [ "$SITE" = "mail" ]; then
  PID_NAME=".http-server.pid"
  LOG_NAME=".http-server.log"
else
  PID_NAME=".http-server-$(basename "$SITE").pid"
  LOG_NAME=".http-server-$(basename "$SITE").log"
fi
OUT_DIR="${DEPLOY_OUT_DIR:-$OUT_ROOT/deploy_$(date +%Y%m%d-%H%M%S)}"
PID_FILE="$OUT_DIR/$PID_NAME"
LOG_FILE="$OUT_DIR/$LOG_NAME"

# 该站点现有的 pid 文件（新时间戳目录 + 旧平铺目录都找，最新的在前）
find_pids() {
  ls -t "$OUT_ROOT"/deploy_*/"$PID_NAME" "$OUT_ROOT"/deploy/"$PID_NAME" 2>/dev/null || true
}
URL="http://127.0.0.1:${PORT}/index.html"

PY="$(command -v python3 || command -v python || true)"
if [ -z "$PY" ]; then
  echo "错误：未找到 python3/python，无法启动静态服务" >&2
  exit 1
fi
# 解析真实解释器路径（macOS /usr/bin/python3 是 shim，kill shim 不会停掉真进程）
REAL_PY="$("$PY" -c 'import sys; print(sys.executable)')" || REAL_PY="$PY"

# 内嵌调优静态服务器：线程化 + keep-alive + 静默 + 大 backlog
TUNED_SERVER='
import os, sys
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler

port, root = int(sys.argv[1]), sys.argv[2]
os.chdir(root)

class Handler(SimpleHTTPRequestHandler):
    protocol_version = "HTTP/1.1"        # keep-alive
    disable_nagle_algorithm = True       # 禁用 Nagle
    def log_message(self, fmt, *args):   # 静默日志
        pass
    def address_string(self):            # 不反查客户端
        return "127.0.0.1"
    def end_headers(self):
        self.send_header("Cache-Control", "no-store")  # 压测每次真实回源
        super().end_headers()

class Server(ThreadingHTTPServer):
    daemon_threads = True
    allow_reuse_address = True
    request_queue_size = 512             # 默认 5

Server(("127.0.0.1", port), Handler).serve_forever()
'

http_ok() { curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/index.html"; }

serve_fg() {
  exec "$REAL_PY" -c "$TUNED_SERVER" "$PORT" "$DOC_ROOT"
}

# 找到该站点存活进程的 pid 文件（无则返回空）。
# 注意：仅 kill -0 不够——服务器死亡后 pid 可能被系统其他进程复用，
# 必须校验进程命令行确实包含本站 DOC_ROOT，避免误判"存活"（拒重启）或误杀。
alive_pid_file() {
  local pf pid cmd
  for pf in $(find_pids); do
    pid="$(cat "$pf" 2>/dev/null)" || continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || continue
    case "$cmd" in
      *"$DOC_ROOT"*) echo "$pf"; return 0 ;;
    esac
  done
  return 0
}

start_bg() {
  local pf
  pf="$(alive_pid_file)"
  if [ -n "$pf" ]; then echo "已在运行 (pid $(cat "$pf"))，入口：$URL"; exit 0; fi
  if http_ok; then echo "端口 $PORT 已有服务在响应：$URL"; exit 0; fi
  mkdir -p "$OUT_DIR"
  ( nohup "$REAL_PY" -c "$TUNED_SERVER" "$PORT" "$DOC_ROOT" >"$LOG_FILE" 2>&1 & echo $! >"$PID_FILE" )
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    http_ok && { echo "已启动 (pid $(cat "$PID_FILE"))，入口：$URL"; exit 0; }
    sleep 0.5
  done
  echo "启动超时，查看日志：$LOG_FILE" >&2
  exit 1
}

stop_bg() {
  local pf pid cmd
  for pf in $(find_pids); do
    pid="$(cat "$pf" 2>/dev/null)" || continue
    cmd="$(ps -p "$pid" -o command= 2>/dev/null)" || true
    case "$cmd" in
      *"$DOC_ROOT"*) kill "$pid" 2>/dev/null || true ;;
    esac
    rm -f "$pf"
  done
  # 兜底：等端口释放，仍被占用则按端口清监听进程（lsof 可用时）
  for _ in 1 2 3 4 5; do http_ok || break; sleep 0.4; done
  if http_ok && command -v lsof >/dev/null 2>&1; then
    lsof -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true
    sleep 0.5
  fi
  if http_ok; then
    echo "警告：端口 $PORT 仍被其他进程占用，请手动处理（lsof -tiTCP:$PORT -sTCP:LISTEN）" >&2
  else
    echo "已停止"
  fi
}

show_status() {
  local pf
  pf="$(alive_pid_file)"
  if [ -n "$pf" ]; then
    echo "运行中 (pid $(cat "$pf"))，入口：${URL}，$(http_ok && echo 'HTTP OK' || echo 'HTTP 无响应')"
  elif http_ok; then
    echo "端口 $PORT 有其他服务在响应：$URL"
  else
    echo "未运行"
  fi
}

case "${1:-run}" in
  run)
    if http_ok; then echo "端口 $PORT 已有服务在响应：$URL"; exit 0; fi
    echo "启动静态服务（site=$SITE）：$URL  (Ctrl+C 停止)"
    serve_fg
    ;;
  start) PORT="${2:-8000}"; URL="http://127.0.0.1:${PORT}/index.html"; start_bg ;;
  stop)  PORT="${2:-8000}"; URL="http://127.0.0.1:${PORT}/index.html"; stop_bg ;;
  status) PORT="${2:-8000}"; URL="http://127.0.0.1:${PORT}/index.html"; show_status ;;
  *) echo "用法：$0 [run|start|stop|status] [port] [site]  （site: mail|shopping|forum|admin|gitlab|目录路径）" >&2; exit 1 ;;
esac
