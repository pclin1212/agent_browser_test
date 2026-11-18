# agent-browser 测试命令文档（稳定选择器版）

适用页面：`mail-demo`（基线闭环）+ `sites/` 下四座替身站（mini-shopping / mini-forum / mini-admin / mini-gitlab）

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
./deploy/deploy.sh                          # 前台启动 mail-demo，默认端口 8000，Ctrl+C 停止
./deploy/deploy.sh 8080                     # 前台启动 mail-demo，指定端口
./deploy/deploy.sh start [port] [site]      # 后台启动（site: mail|shopping|forum|admin|gitlab）
./deploy/deploy.sh stop [port] [site]       # 停止后台服务（含端口兜底清理）
./deploy/deploy.sh status [port] [site]     # 查看运行状态
./deploy/deploy_all.sh [start|stop|status|restart]   # 一键批量管理全部五站（默认 start）
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

逐条执行 agent-browser 闭环指令，记录每条指令耗时与 run 总耗时，支持并发，汇总 p50/p95/p99/mean/min/max。每次运行自动创建独立产物目录 `output/bench_c<并发>_n<次数>_<时间戳>/`（内含 `bench-report.md` + `bench-results.json`，以及失败时的 `failures/` 截图），不同轮次天然不覆盖：

```bash
python3 bench/bench.py                  # 5 次运行，无并发
python3 bench/bench.py -n 10 -c 2       # 10 次运行，2 路并发
python3 bench/bench.py --bin /path/to/agent-browser        # 指定二进制（或环境变量 AGENT_BROWSER_BIN）
python3 bench/bench.py --url http://127.0.0.1:8000/index.html  # 指定入口（默认 file:// 仓库 html/index.html）
python3 bench/bench.py --think-time 3000                # 指令间插入 3000ms±30% 思考时间（模拟 LLM 生成间隙）
```

`--think-time MS`（默认 0=关闭）在每两条指令之间插入随机延迟（`--think-jitter PCT` 控制抖动，默认 ±30%），模拟真实 agent 会话中大模型逐条生成指令的间隙——用于容量/占用类压测（会话资源占用、可持续并发数）；默认关闭保证延迟测量口径不受污染，报告头部会记录 think_time 配置，两种口径的报告不可混比。

说明：

- 每个 run 使用独立一次性状态目录（socket + Chrome profile），并发互不干扰；daemon 空闲 15s 自动退出、Chrome 随之关闭，系统零残留。
- `--bin` 未指定时按 PATH → npx 顺序查找；经 npx 启动会引入 node 进程开销（每条指令约 +200~500ms），正式测量建议用全局安装的原生二进制。
- 退出码：全部成功 0，存在失败 2。失败 run 的错误信息在报告「失败记录」章节。

## 用例合集模式（bench/bench.py --cases）

把任意站点的测试组织成 `cases/*.json`，每个用例 = 一次完整的 agent-browser 指令序列 + 功能断言：

```json
{
  "name": "mini-shopping-03-search-ugreen",
  "env": "mini-shopping",
  "category": "search",
  "base_url": "http://127.0.0.1:8010",
  "start_url": "{BASE}/",
  "steps": [
    ["open", "{BASE}/"],
    ["wait", "--load", "networkidle"],
    ["click", "#search"],
    ["press", "u"],
    ["press", "g"],
    ["press", "Enter"],
    ["wait", "--load", "networkidle"]
  ],
  "steps_note": "陷阱1：搜索框只认真实键事件，fill/type 会被静默拦截，必须逐字符 press",
  "asserts": [
    {"desc": "ugreen 结果页标题与价格 6.99", "cmd": ["get", "text", "body"],
     "op": "contains_all", "expect": ["Search results for: 'ugreen'", "$6.99"]}
  ]
}
```

- `steps`：agent-browser 指令数组，支持 `{start_url}` / `{BASE}`（= `base_url`）占位符
- `asserts.op`：`contains` / `contains_all` / `contains_any` / `equals` / `re` / `nonempty`，对断言命令的 stdout 判定；断言在所有 steps 之后执行（终态断言）
- 双口径成功率：**指令成功**（所有 steps rc==0）vs **功能成功**（断言全部通过）——借鉴 WebArena/OSWorld 的"功能断言而非仅看退出码"
- 任一层失败自动 `screenshot` 到 `bench/failures/<case>__run<n>__<tag>__<时间>.png` 留证
- 指令按动词分桶统计耗时（open / wait / fill / click / press / select / get / eval）

```bash
python3 bench/bench.py --cases cases -n 3 -c 2   # 合集内所有用例，每个 3 次，2 路并发
# 报告：output/bench_c<并发>_n<次数>_<时间戳>/cases-report.md + cases-results.json
# 前置：把五个站点全部启动（mail 8000 / shopping 8010 / forum 8020 / admin 8030 / gitlab 8040）
```

## 可选命令

只提取邮件摘要（第 7 步筛选后执行）：

```bash
agent-browser get text "#filtered-result"
```

## 输入事件模型：fill / type / press 的关键差异（实测）

在 mini-shopping 站上用事件探针实测（对同一输入框挂 keydown/keypress/input 监听）：

| 指令 | 触发的事件 | 说明 |
|---|---|---|
| `fill` | 仅 `input`（每字符 1 次） | 直写 value + input 事件，**不发键事件** |
| `type` | 仅 `input`（每字符 1 次） | 与 fill 事件模型相同，逐字符派发 |
| `press X` | `keydown` + `keypress` + `input` | **完整真实键事件链** |

推论：真实世界中只监听 keydown/keypress 的组件（自动补全、快捷键输入框、部分 knockout/自定义组件）用 `fill`/`type` 会**静默无效**——页面不动、rc==0，只有 `press`（或物理键盘）能生效。这正是 WebArena 搜索用例第一轮翻车的机制，也是 `sites/mini-shopping/` 陷阱1的设计依据。写用例时对"输入后无反应"的控件，先怀疑事件模型，改用 `click`（聚焦）+ 逐字符 `press`。

## 交互模型补充实测（mini-forum / mini-admin / mini-gitlab 三站验证）

在三个新站的建设过程中补充实测了四类交互形态，结论可直接指导用例编写：

### 1. contenteditable 富文本编辑器

`fill` 在 contenteditable 元素（如 mini-forum 发帖页 `#editor`）上**有效**：直写 textContent + 派发 input 事件，站点侧用 `element.textContent` 读取即可拿到内容。不需要 press 逐字符输入。

### 2. 原生 `<select>` vs 自定义 div 下拉

- **原生 `<select>`**：`select "#id" "value"` 指令有效（mini-admin `#mass-action`、mail `#date-filter`）。部分站点只监听 change 不监听 input，稳妥起见可让站点侧对 change + input 双通道监听。
- **自定义 div 下拉**（mini-forum 标签选择器、mini-gitlab label 选择器）：`select` 指令**完全无效**（它只作用于原生 `<select>`）。且选项面板是懒渲染——点击 toggle（`#tag-dropdown-toggle` / `#label-toggle`）前选项不在 DOM，直接 click 隐藏选项会因元素不存在而失败。正确路径是 `click toggle` → `click 选项` 两步。

### 3. 懒渲染 / 动态插入的元素

对点击后才插入 DOM 的元素（mini-gitlab 文件树深层行、mini-admin `#confirm-modal`），任何提前的 `get`/`click` 都会因元素不存在而失败（rc!=0）。用例必须按"先触发展开/插入，再交互"的顺序写；必要时在 steps 中插入一条 `get`（如 `get text "#confirm-modal"`）验证元素已经出现。

### 4. 静默拦截：rc==0 ≠ 功能成功

事件处理器内 `return`（未登录点赞、未选动作的批量 Apply、缺标题的提交）对 agent-browser 完全不可见：**指令 rc==0、无报错、无导航**。只有终态功能断言（票数没变、弹窗没出现、URL 未变）才能暴露。这就是合集坚持双成功率口径的原因。负向断言写法：`asserts.op = "re"` + 负向前瞻 `(?s)^(?!.*不应出现的文本)`。

### 5. 元素遮挡：click 的 actionability 检查

`click` 会做遮挡检查：若目标元素的点击坐标被其他元素覆盖（实测：mini-forum 标签下拉面板展开后盖住 `#submit-btn`），指令直接失败并报 `Element ... is covered by <...>`。站点侧在选中选项后应关闭面板（本仓已改为选中即 `classList.remove("open")`）；用例侧则必须保证点击路径上没有浮层。

### 6. 输入管线死亡：fill 特定字符串 + 导航后会话级 click/press 静默失效（agent-browser 0.41.2 实测）

**现象**：fill 邮箱/人名点分格式字符串（实测 `emma.lopez@gmail.com`、`emma.lopez` 稳定致死；`admin`、`xyz.lopez`、`a.b`、`a@b`、`emma@gmail` 均安全）到表单字段后，页面发生导航（表单提交跳转、`location.href`、eval 触发的 JS click 均可），此后**该会话所有 click/press 静默失效**：rc==0 但零事件派发（capture 监听探针实测）。fill/type/eval/get/screenshot 不受影响。死亡是会话级的（daemon + Chrome 生命周期内不可恢复）。

**已排除**（对照实验矩阵，2026-11 深度调试）：与站点/服务进程/端口/页面骨架/资源/跳转目标/提交方式（agent-browser click vs eval JS click vs type 逐键）/`autocomplete="off"`/Chrome `--disable-features=Autofill,PasswordLeakDetection,PasswordManager`（已确认 flag 传到了 chrome 进程仍无效）均无关；只与 fill 进字段的**值**有关，疑似 Chrome 对人名点分格式的内部启发式与 headless 输入管线冲突。

**规避**：需要"登录后继续 click"的用例，登录改用 `eval` 直写 token（如 `localStorage.setItem('ms_token', '...')`），登录表单交互由断言不依赖后续 click 的用例单独覆盖（如 `mini-shopping-01-login`：fill+click 提交后仅用 `eval location.href` / `get text` 断言）。见 `cases/mini-shopping-11-account-edit.json` 的 steps_note。

## mini-shopping 站（sites/mini-shopping/）

WebArena 复杂度的 KB 级静态替身站，复刻三个真实世界陷阱（keydown-only 搜索 / Reviews tab 懒渲染 / 必选商品选项静默验证），数据值与 WebArena 标定点一致，选择器与 Magento 同名（`#email`/`#pass`/`#send2`/`#search`/`#tab-label-reviews`/`options[51745]`/`#product-addtocart-button`），用例见 `cases/mini-shopping-*.json`。部署：

```bash
./deploy/deploy.sh start 8010 shopping     # 入口 http://127.0.0.1:8010/index.html
./deploy/deploy.sh stop 8010 shopping
```

## mini-forum / mini-admin / mini-gitlab 站（sites/）

三个新替身站复刻 WebArena 另外三大家族场景，陷阱机制与用例清单见仓库 README 第 5 节，各站 app.js 头部亦有 `[陷阱N]` 注释：

```bash
./deploy/deploy.sh start 8020 forum        # mini-forum（NodeBB 复刻），http://127.0.0.1:8020/
./deploy/deploy.sh start 8030 admin        # mini-admin（Magento admin 复刻），http://127.0.0.1:8030/
./deploy/deploy.sh start 8040 gitlab       # mini-gitlab（GitLab 复刻），http://127.0.0.1:8040/
```

关键选择器速查（用例均已静态固化）：

| 站点 | 登录 | 关键交互 |
|---|---|---|
| mini-forum | `/login.html`（`#username`/`#password`/`#login-btn`，alice/bob/carol / `Password.123`） | 发帖 `compose.html`（`#post-title`/`#editor`/`#tag-dropdown-toggle`/`#submit-btn`）；点赞 `.upvote-btn`/`#votes-*`；详情 `/topic/<id>/` |
| mini-admin | `/admin/login/`（admin / `Password.123`） | 订单列表 `/admin/sales/order/`（筛选 `#f-*`/`#filter-customer`/`#filter-btn`，批量 `#mass-action`/`.order-checkbox`/`#apply-btn`/`#confirm-yes`）；详情 `/admin/sales/order/view/?id=` |
| mini-gitlab | `/users/sign_in/`（root / `Password.123`） | 文件树 `tree.html`（`.tree-item`）；代码 `blob.html?file=`；issue `/issues/`（`#state-filter`）、`/issues/new/`（`#issue-title`/`#label-toggle`） |

## 备注

- 选择器与页面对应关系：登录页 `#username`/`#password`/`#login-button`；主页 `#inbox-entry`；收件箱 `#date-filter`/`#search-button`/`#filtered-result`/`#all-mails`；正文页 `article[aria-label='邮件正文']`。只要这些 id 不改，本表可静态复用。
- 若个别版本的 `get text` 不接受 CSS 选择器，可退回 `snapshot -i` 取该步骤的 ref（仅此一步需要动态 ref），或改用 `agent-browser eval "document.querySelector(\"article[aria-label='邮件正文']\").innerText"`。
- 手动逐条执行时，可按需把状态隔离到临时目录（Cookie/localStorage/缓存不落系统）：

  ```bash
  export AGENT_BROWSER_SOCKET_DIR="$ISO"       # CLI<->daemon 通信 socket
  export AGENT_BROWSER_PROFILE="$ISO/profile"  # Chrome 用户数据
  ```

  受限环境（如被沙箱化的终端）中默认的 `~/.agent-browser` socket 可能报 `Operation not permitted`，把 socket 目录重定向到 `/tmp` 即可绕过（bench.py 每个 run 已内置此隔离）。
