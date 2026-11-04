# agent_browser_test

基于 [agent-browser](https://www.npmjs.com/package/agent-browser) 的邮箱闭环自动化测试项目，包含三部分：

- **稳定选择器测试方案** —— 解决 `snapshot -i` 生成的 `@e*` 临时 ref 每次漂移、无法静态复用的问题，全部改用 CSS 选择器（`#id`）
- **高并发静态部署服务** —— 内嵌调优的线程化 Python 服务器，保证压测时静态服务不成为瓶颈
- **指令级基准测试** —— 逐条记录 agent-browser 指令耗时，支持并发，输出 p50/p95/p99/mean 等统计

## 目录结构

```text
├── README.md
├── deploy/
│   └── deploy.sh          # 一键部署静态服务（高并发调优后端）
├── bench/
│   ├── bench.py           # 指令级基准测试
│   ├── bench-report.md    # 压测报告（运行 bench.py 自动生成）
│   └── bench-results.json # 原始计时数据（自动生成）
├── html/                  # 模拟邮箱页面（登录 → 主页 → 收件箱 → 邮件正文）
│   ├── index.html
│   ├── home.html
│   ├── inbox.html
│   ├── detail.html
│   ├── app.js
│   └── style.css
└── docs/
    ├── agent-browser-commands.md  # 完整命令文档（选择器映射表、原理、排障）
    └── test_terminal_res.txt      # 早期 @e* ref 漂移问题的原始测试记录
```

## 快速开始

### 1. 启动静态服务（高并发后端）

```bash
./deploy/deploy.sh start 8000     # 后台启动，入口 http://127.0.0.1:8000/index.html
./deploy/deploy.sh status         # 查看状态
./deploy/deploy.sh stop          # 停止
```

后端不是 `python -m http.server`，而是针对压测调优的线程化服务器：HTTP/1.1 keep-alive（吞吐 2337 req/s，约为默认实现 3.2 倍）、listen backlog 512、静默日志、TCP_NODELAY、`Cache-Control: no-store`。150 并发 x 1000 请求实测全部成功，静态服务零压力，压测瓶颈始终在 Chrome/agent-browser 侧。

### 2. 跑基准测试

```bash
# 先安装 agent-browser（正式测量建议全局安装，避免 npx 引入 node 进程开销）
npm i -g agent-browser

python3 bench/bench.py -n 10 -c 2     # 10 次运行，2 路并发
```

每次 run 执行完整邮箱闭环（打开登录页 → 登录 → 收件箱 → 筛选"今天" → 读取唯一邮件正文 → close → session list），逐条记录 16 个指令的耗时。每个 run 使用独立的一次性状态目录（socket + Chrome profile），并发互不干扰，daemon 空闲 15s 自动退出，系统零残留。

报告输出到 `bench/bench-report.md`（含各指令与 run 的 min/p50/mean/p95/p99/max）和 `bench/bench-results.json`（原始逐次数据）。

### 3. 手动逐条执行（稳定选择器版）

```bash
agent-browser open "http://127.0.0.1:8000/index.html" && agent-browser wait --load networkidle
agent-browser fill "#username" "2021001234"
agent-browser fill "#password" "Jack@2024"
agent-browser click "#login-button" && agent-browser wait --load networkidle
agent-browser click "#inbox-entry" && agent-browser wait --load networkidle
agent-browser select "#date-filter" "今天"
agent-browser click "#search-button" && agent-browser wait --load networkidle
agent-browser click "#filtered-result a.mail-item" && agent-browser wait --load networkidle
agent-browser get text "article[aria-label='邮件正文']"
agent-browser close
agent-browser session list
```

为什么不用 `@e*`：`snapshot -i` 生成的 ref 是按可访问性树遍历顺序的临时编号，新开 session、页面重载、DOM 显隐变化都会导致编号漂移，静态写死必然失效。页面元素全部有稳定 `id`，而 `fill`/`click`/`select`/`get text` 原生支持 CSS 选择器，因此命令可静态复用，`snapshot -i` 步骤可全部省略。

完整的选择器映射、原理说明和排障备注见 [docs/agent-browser-commands.md](docs/agent-browser-commands.md)。

## 实测参考数据（4 路并发 x 4 run，macOS x86_64）

| 指标 | 数值 |
|---|---|
| 单 run 闭环总耗时 | p50 ≈ 16.8 s |
| `open`（首次拉起浏览器） | p50 ≈ 9.6 s |
| `wait --load networkidle` | 0.8 ~ 1.6 s / 页 |
| 纯交互指令（fill/click/select/get text） | p50 18 ~ 119 ms |
| 静态服务吞吐（单连接 keep-alive） | 2337 req/s |

## 依赖

- Python 3（标准库即可，无需第三方包）
- [agent-browser](https://www.npmjs.com/package/agent-browser) CLI
- Chrome（agent-browser 自动管理）
