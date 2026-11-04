# agent-browser 邮箱闭环测试命令表（稳定选择器版）

适用页面：`mail-demo`

## 为什么 @e* 编号会变、如何静态测试

`@e5` 这类 ref 是 `snapshot -i` 执行时按**可访问性树遍历顺序**生成的临时编号，只在当次 snapshot 内保证有效。以下情况都会导致编号漂移：

- 新开 session / 页面重载后重新 snapshot；
- DOM 显隐变化（如 `#filtered-result` 与 `#filter-panel` 互换、`#toast` 弹出和消失，见 `app.js`）；
- 浏览器或 agent-browser 版本更新导致 a11y 树顺序差异。

因此**静态测试不要依赖 `@e*`**。本项目所有交互元素都有稳定的 HTML `id`，而 agent-browser 的 `open`/`fill`/`click`/`select`/`get text` 均直接支持 CSS 选择器。下表全部改用 `#id`，编号漂移不再影响测试，`snapshot -i` 步骤也可省略（仍可手动执行用于人工核对页面状态）。

## 启动静态服务

在仓库根目录执行（详见下文 deploy.sh 一节）：

```bash
./deploy/deploy.sh start 8000
```

入口：`http://127.0.0.1:8000/index.html`

（也可直接用 `file://<仓库>/html/index.html`。）

## 命令表

| 步骤 | agent-browser 指令 | 说明 |
|---|---|---|
| 1 | `agent-browser open "http://127.0.0.1:8000/index.html" && agent-browser wait --load networkidle` | 打开邮箱登录页 |
| 2 | `agent-browser fill "#username" "2021001234"` | 账号输入框（html/index.html `#username`） |
| 3 | `agent-browser fill "#password" "Jack@2024"` | 密码输入框（html/index.html `#password`） |
| 4 | `agent-browser click "#login-button" && agent-browser wait --load networkidle` | 登录按钮（html/index.html `#login-button`），跳转 home.html |
| 5 | `agent-browser click "#inbox-entry" && agent-browser wait --load networkidle` | 邮箱主页“收件箱”入口（html/home.html `#inbox-entry`），进入收件箱 |
| 6 | `agent-browser select "#date-filter" "今天"` | 时间筛选选“今天”（html/inbox.html `#date-filter`；按 value 亦可：`"today"`） |
| 7 | `agent-browser click "#search-button" && agent-browser wait --load networkidle` | 点击“搜索/筛选”（html/inbox.html `#search-button`），列表只剩 1 封今日邮件 |
| 8 | `agent-browser click "#filtered-result a.mail-item" && agent-browser wait --load networkidle` | 点击筛选后唯一的今日邮件（html/inbox.html `#filtered-result`），进入正文页 |
| 9 | `agent-browser get text "article[aria-label='邮件正文']"` | 提取邮件正文（html/detail.html 正文 article） |
| 10 | `agent-browser close` | 关闭页面 |
| 11 | `agent-browser session list` | 检查是否关闭 |

## 一键部署静态服务（deploy/deploy.sh · 高并发）

```bash
./deploy/deploy.sh              # 前台启动，默认端口 8000，Ctrl+C 停止
./deploy/deploy.sh 8080         # 前台启动，指定端口
./deploy/deploy.sh start [port] # 后台启动（deploy/.http-server.pid / .http-server.log）
./deploy/deploy.sh stop         # 停止后台服务（含端口兜底清理）
./deploy/deploy.sh status       # 查看运行状态
```

后端是内嵌的调优线程化服务器（不是 `python -m http.server`），专为压测 agent-browser 设计，避免静态服务自身成为瓶颈：

| 优化项 | 原因 |
|---|---|
| HTTP/1.1 keep-alive | 连接复用，消除高并发下的 TCP churn（实测吞吐 2337 req/s vs 普通 http.server 725 req/s） |
| 静默访问日志 | 去掉逐请求写日志的磁盘/锁开销 |
| listen backlog 512 | 默认值 5，并发接入风暴下会丢 SYN |
| TCP_NODELAY | 小文件响应立即发出，降延迟 |
| `Cache-Control: no-store` | 每次真实回源，保证各轮压测数据可比（不会被 Chrome 缓存"吃掉"请求） |

实测：150 并发 x 1000 请求全部成功；4 路并发浏览器端到端压测全部 OK。压测瓶颈在 Chrome/机器本身，静态服务零压力。脚本会自动解析真实 python 路径（规避 macOS python3 shim 导致 stop 后进程残留的问题）。

## 指令级基准测试（bench/bench.py）

逐条执行 agent-browser 闭环指令，记录每条指令耗时与 run 总耗时，支持并发，汇总 p50/p95/p99/mean/min/max，输出 `bench/bench-report.md` + `bench/bench-results.json`：

```bash
python3 bench/bench.py                  # 5 次运行，无并发
python3 bench/bench.py -n 10 -c 2       # 10 次运行，2 路并发
python3 bench/bench.py --bin /path/to/agent-browser        # 指定二进制（或环境变量 AGENT_BROWSER_BIN）
python3 bench/bench.py --url http://127.0.0.1:8000/index.html  # 指定入口（默认 file:// 仓库 html/index.html）
```

说明：

- 每个 run 使用独立一次性状态目录（socket + Chrome profile），并发互不干扰；daemon 空闲 15s 自动退出、Chrome 随之关闭，系统零残留。
- `--bin` 未指定时按 PATH → npx 顺序查找；经 npx 启动会引入 node 进程开销（每条指令约 +200~500ms），正式测量建议用全局安装的原生二进制。
- 退出码：全部成功 0，存在失败 2。失败 run 的错误信息在报告「失败记录」章节。

## 可选命令

只提取邮件摘要（第 7 步筛选后执行）：

```bash
agent-browser get text "#filtered-result"
```

## 备注

- 选择器与页面对应关系：登录页 `#username`/`#password`/`#login-button`；主页 `#inbox-entry`；收件箱 `#date-filter`/`#search-button`/`#filtered-result`/`#all-mails`；正文页 `article[aria-label='邮件正文']`。只要这些 id 不改，本表可静态复用。
- 若个别版本的 `get text` 不接受 CSS 选择器，可退回 `snapshot -i` 取该步骤的 ref（仅此一步需要动态 ref），或改用 `agent-browser eval "document.querySelector(\"article[aria-label='邮件正文']\").innerText"`。
- 手动逐条执行时，可按需把状态隔离到临时目录（Cookie/localStorage/缓存不落系统）：

  ```bash
  export AGENT_BROWSER_SOCKET_DIR="$ISO"       # CLI<->daemon 通信 socket
  export AGENT_BROWSER_PROFILE="$ISO/profile"  # Chrome 用户数据
  ```

  受限环境（如被沙箱化的终端）中默认的 `~/.agent-browser` socket 可能报 `Operation not permitted`，把 socket 目录重定向到 `/tmp` 即可绕过（bench.py 每个 run 已内置此隔离）。
