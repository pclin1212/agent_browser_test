# agent_browser_test

基于 [agent-browser](https://www.npmjs.com/package/agent-browser) 的浏览器操控负载压测项目。自包含、零外部依赖（git clone 即可复现全部结果），包含四部分：

- **稳定选择器测试方案** —— 解决 `snapshot -i` 生成的 `@e*` 临时 ref 每次漂移、无法静态复用的问题，全部改用 CSS 选择器（`#id`）
- **高并发静态部署服务** —— 内嵌调优的线程化 Python 服务器，保证压测时静态服务不成为瓶颈
- **指令级基准测试** —— 逐条记录 agent-browser 指令耗时，双成功率口径（指令成功 ≠ 功能成功），分桶统计
- **五个自建被测站点 + 用例合集** —— mail-demo（极简基线）+ mini-shopping / mini-forum / mini-admin / mini-gitlab（四座 KB 级静态替身站，复刻 WebArena 四大家族场景的交互陷阱）

## 目录结构

```text
├── README.md
├── deploy/
│   └── deploy.sh                  # 静态站点一键部署（mail / shopping / forum / admin / gitlab 多站点，高并发调优后端）
├── bench/
│   ├── bench.py                   # 指令级基准测试（闭环模式 + --cases 用例合集模式）
│   ├── bench-report.md            # 闭环模式报告（运行 bench.py 自动生成）
│   ├── bench-results.json         # 闭环模式原始计时数据（自动生成）
│   ├── cases-report.md            # 用例合集报告（--cases 模式自动生成）
│   ├── cases-results.json         # 用例合集原始数据（自动生成）
│   ├── archive/                   # 每轮跑完自动按时间戳留档（报告 + 原始数据，永不覆盖）
│   └── failures/                  # --cases 失败自动截图留证（自动生成）
├── cases/                         # 用例合集（*.json，每个 = env + start_url + steps + asserts + category）
│   ├── mail-demo-*.json           # mail-demo 站点用例（基线，2 个）
│   ├── mini-shopping-*.json       # mini-shopping 站用例（10 个）
│   ├── mini-forum-*.json          # mini-forum 站用例（11 个，NodeBB 论坛复刻）
│   ├── mini-admin-*.json          # mini-admin 站用例（9 个，Magento admin 后台复刻）
│   └── mini-gitlab-*.json         # mini-gitlab 站用例（10 个，GitLab 复刻）
├── html/                          # mail-demo：模拟邮箱页面（登录 → 主页 → 收件箱 → 邮件正文）
├── sites/                         # KB 级静态替身站（进仓库可永久复现）
    ├── mini-shopping/              # WebArena 电商复杂度替身（进仓库可永久复现）
    │   ├── index.html / search.html / 两个商品页
    │   ├── customer/ sales/ checkout/     # 登录、账户、订单、购物车（镜像 Magento URL 结构）
    │   └── data.js / app.js / style.css
    ├── mini-forum/                 # NodeBB 论坛复刻（分类过滤 / 嵌套回复 / contenteditable 发帖 / 点赞静默拦截）
    ├── mini-admin/                 # Magento admin 复刻（60 单大表格分页 / 多条件筛选 / 批量动作 / 确认弹窗）
    └── mini-gitlab/                # GitLab 复刻（懒渲染文件树 / 长内容提取 / 自定义下拉 / issue 全流程）
└── docs/
    ├── agent-browser-commands.md  # 完整命令文档（选择器映射表、原理、排障）
    └── test_terminal_res.txt      # 早期 @e* ref 漂移问题的原始测试记录
```

## 快速开始

### 1. 启动静态服务（高并发后端，支持多站点）

```bash
./deploy/deploy.sh start 8000              # mail-demo，入口 http://127.0.0.1:8000/index.html
./deploy/deploy.sh start 8010 shopping     # mini-shopping，入口 http://127.0.0.1:8010/index.html
./deploy/deploy.sh start 8020 forum        # mini-forum，入口 http://127.0.0.1:8020/index.html
./deploy/deploy.sh start 8030 admin        # mini-admin，入口 http://127.0.0.1:8030/index.html
./deploy/deploy.sh start 8040 gitlab      # mini-gitlab，入口 http://127.0.0.1:8040/index.html
./deploy/deploy.sh status 8000 [shopping]  # 查看状态（默认 mail；stop/status 同样接 [port] [site]）
./deploy/deploy.sh stop 8000 [shopping]    # 停止
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

### 3. 用例合集模式（--cases）

把任意站点的测试组织成 `cases/*.json` 用例（schema：`env` / `start_url` / `steps[]`（agent-browser 指令数组，支持 `{start_url}`、`{BASE}` 占位符）/ `asserts[]`（指令 + 期望值断言）/ `category`），然后一把压测：

```bash
./deploy/deploy.sh start 8000              # mail 站
./deploy/deploy.sh start 8010 shopping     # mini-shopping 站
./deploy/deploy.sh start 8020 forum        # mini-forum 站
./deploy/deploy.sh start 8030 admin        # mini-admin 站
./deploy/deploy.sh start 8040 gitlab       # mini-gitlab 站
python3 bench/bench.py --cases cases -n 3 -c 2     # 36 个用例，每个 3 次，2 路并发
```

报告（`bench/cases-report.md` + `cases-results.json`）区分两个口径的成功率：

- **指令成功率**：所有 steps 命令 rc==0（agent-browser 执行层没问题）
- **功能成功率**：且所有 asserts 通过（页面真的到达了预期状态，借鉴 WebArena/OSWorld 的"功能断言而非仅看退出码"）

同时按命令动词分桶统计耗时（open / wait / fill / click / press / select / get / eval），任一层失败会自动截图到 `bench/failures/` 留证。

每轮跑完后，报告与原始数据会自动按时间戳复制一份到 `bench/archive/`（如 `cases-report-20261106-215905.md`），固定名文件只代表"最新一轮"，历史轮次永不覆盖丢失。

当前合集 42 个用例：mail-demo 2 个（极简基线）+ **mini-shopping 10 个** + **mini-forum 11 个 / mini-admin 9 个 / mini-gitlab 10 个**（四座 KB 级静态替身站，git clone 即可复现）。

### 4. mini-shopping：WebArena 复杂度的自包含替身站

WebArena 官方镜像动辄上百 GB、需 docker import + base_url 配置，不适合日常回归和 CI。`sites/mini-shopping/` 把 WebArena 踩过的三个"真实世界陷阱"用原生 JS 复刻进一个 KB 级静态站（数据值与 WebArena 标定点一致）：

| 陷阱 | 机制 | 用例体现 |
|---|---|---|
| keydown-only 搜索框 | 只认真实键事件（press），fill/type 只派发 input 事件会被静默拦截 | mini-02/03/10 逐字符 press |
| Reviews 懒渲染 | 评论内容点击 `#tab-label-reviews` 前不存在于 DOM | mini-07/08 必须先点 tab |
| 必选选项静默验证 | 未勾选 `options[51745]` 时点加购 rc==0 但无导航 | mini-09 必须先选选项 |

**口径提醒**：mini 数字比真实站点偏乐观（无网络往返、无后端计算），引用压测数据时应注明偏差方向。

### 5. mini-forum / mini-admin / mini-gitlab：更多 WebArena 场景的静态替身站

WebArena 的另外三大家族场景（论坛 / 后台管理 / 代码托管）同样用 KB 级静态站复刻。每个站都把该场景最典型的"陷阱"用原生 JS 固化进交互路径，且全部用例的断言值都能由冻结数据静态推演：

| 站点（端口） | 复刻对象 | 关键交互陷阱 | 用例数 |
|---|---|---|---|
| mini-forum（8020） | NodeBB 论坛 | F1 发帖标签是自定义 div 下拉（选项点击 `#tag-dropdown-toggle` 后才懒渲染，`select` 指令无效）；F2 未登录点赞静默拦截（rc==0、票数不变）；contenteditable 富文本编辑器；普通 form GET 搜索作正常对照组 | 9 |
| mini-admin（8030） | Magento admin 后台 | A1 批量动作未选/未勾选时点 Apply 在处理器内静默 return；A2 delete 确认弹窗（`#confirm-modal`）点击 Apply 后才懒插入 DOM；60 单大表格分页 + 状态/客户/日期多条件组合筛选 | 7 |
| mini-gitlab（8040） | GitLab | G1 文件树逐层懒渲染（跳步点深层行必失败，须逐层展开）；G2 139 行长内容单条提取；G3 label 自定义 div 下拉（同 F1）；新 issue 空标题静默拦截 | 8 |

三个站与 mini-shopping 一样零外部依赖、`git clone` 即可复现、`deploy.sh start <port> <site>` 一条命令启动，适合日常回归和 CI。

### 6. 手动逐条执行（稳定选择器版）

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
