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
│   ├── deploy.sh                  # 静态站点部署（mail / shopping / forum / admin / gitlab，高并发调优后端）
│   └── deploy_all.sh              # 一键批量管理全部五站（start / stop / status / restart）
├── bench/
│   └── bench.py                   # 指令级基准测试（闭环模式 + --cases 用例合集模式）
├── output/                        # 运行产物统一收纳（不入库，git ignore）
│   ├── bench_c<并发>_n<次数>_<时间戳>/   # 每次运行独立目录（bench.py 自动创建），内含
│   │                              #   bench-report.md / cases-report.md
│   │                              #   / bench-results.json / cases-results.json
│   │                              #   / failures/（失败截图），天然不覆盖、无需归档
│   └── deploy_<时间戳>/           # deploy.sh / deploy_all.sh 生成：.http-server*.pid / .log
│                                  #   （每次启动独立目录；deploy_all.sh 批量启动共享一个）
├── cases/                         # 用例合集（*.json，每个 = env + start_url + steps + asserts + category）
│   ├── mail-demo-*.json           # mail-demo 站点用例（基线，2 个）
│   ├── mini-shopping-*.json       # mini-shopping 站用例（12 个）
│   ├── mini-forum-*.json          # mini-forum 站用例（14 个，NodeBB 论坛复刻）
│   ├── mini-admin-*.json          # mini-admin 站用例（12 个，Magento admin 后台复刻）
│   ├── mini-gitlab-*.json         # mini-gitlab 站用例（12 个，GitLab 复刻）
│   └── cross-*.json               # 跨站任务用例（2 个，同一浏览器会话内跨站点传递信息）
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
./deploy/deploy_all.sh                     # 一键拉起全部五站（也可 start/stop/status/restart）
# 或者单独启动某一站：
./deploy/deploy.sh start 8000              # mail-demo，入口 http://127.0.0.1:8000/index.html
./deploy/deploy.sh start 8010 shopping     # mini-shopping，入口 http://127.0.0.1:8010/index.html
./deploy/deploy.sh start 8020 forum        # mini-forum，入口 http://127.0.0.1:8020/index.html
./deploy/deploy.sh start 8030 admin        # mini-admin，入口 http://127.0.0.1:8030/index.html
./deploy/deploy.sh start 8040 gitlab       # mini-gitlab，入口 http://127.0.0.1:8040/index.html
./deploy/deploy.sh status 8000 [shopping]  # 查看状态（默认 mail；stop/status 同样接 [port] [site]）
./deploy/deploy.sh stop 8000 [shopping]    # 停止
```

后端不是 `python -m http.server`，而是针对压测调优的线程化服务器：HTTP/1.1 keep-alive（吞吐 2337 req/s，约为默认实现 3.2 倍）、listen backlog 512、静默日志、TCP_NODELAY、`Cache-Control: no-store`。150 并发 x 1000 请求实测全部成功，静态服务零压力，压测瓶颈始终在 Chrome/agent-browser 侧。

### 2. 跑基准测试

```bash
# 先安装 agent-browser（正式测量建议全局安装，避免 npx 引入 node 进程开销）
npm i -g agent-browser

python3 bench/bench.py -n 10 -c 2     # 10 次运行，2 路并发
python3 bench/bench.py --think-time 3000   # 指令间加 3s±30% 思考时间（可选）
```

`--think-time`（默认 0=关闭）在指令间插入随机延迟，模拟真实 agent 会话中大模型生成指令的间隙，用于容量/可持续并发类压测；延迟测量对比（如跨平台算力对比）请保持关闭。报告会记录该配置，两种口径不可混比。

每次 run 执行完整邮箱闭环（打开登录页 → 登录 → 收件箱 → 筛选"今天" → 读取唯一邮件正文 → close → session list），逐条记录 16 个指令的耗时。每个 run 使用独立的一次性状态目录（socket + Chrome profile），并发互不干扰，daemon 空闲 15s 自动退出，系统零残留。

每次运行自动创建独立目录 `output/bench_c<并发>_n<次数>_<时间戳>/`（如 `bench_c2_n10_20261107-234443`），报告 `bench-report.md`（含各指令与 run 的 min/p50/mean/p95/p99/max）与原始数据 `bench-results.json` 都在其中，运行目录互不覆盖。

### 3. 用例合集模式（--cases）

把任意站点的测试组织成 `cases/*.json` 用例（schema：`env` / `start_url` / `steps[]`（agent-browser 指令数组，支持 `{start_url}`、`{BASE}` 占位符）/ `asserts[]`（指令 + 期望值断言）/ `category`），然后一把压测：

```bash
./deploy/deploy.sh start 8000              # mail 站
./deploy/deploy.sh start 8010 shopping     # mini-shopping 站
./deploy/deploy.sh start 8020 forum        # mini-forum 站
./deploy/deploy.sh start 8030 admin        # mini-admin 站
./deploy/deploy.sh start 8040 gitlab       # mini-gitlab 站
python3 bench/bench.py --cases cases -n 3 -c 2     # 54 个用例，每个 3 次，2 路并发
```

报告（本次运行目录下的 `cases-report.md` + `cases-results.json`，目录形如 `output/bench_c2_n3_20261107-234443/`）区分两个口径的成功率：

- **指令成功率**：所有 steps 命令 rc==0（agent-browser 执行层没问题）
- **功能成功率**：且所有 asserts 通过（页面真的到达了预期状态，借鉴 WebArena/OSWorld 的"功能断言而非仅看退出码"）

同时按命令动词分桶统计耗时（open / wait / fill / click / press / select / get / eval），任一层失败会自动截图到本次运行目录的 `failures/` 留证。

每次运行的所有产物（报告 / 原始 JSON / 失败截图）都收纳在自动创建的独立目录 `output/bench_c<并发>_n<次数>_<时间戳>/` 中，不同轮次天然隔离、永不覆盖，无需额外归档。

当前合集 54 个用例：mail-demo 2 个（极简基线）+ **mini-shopping 12 个** + **mini-forum 14 个 / mini-admin 12 个 / mini-gitlab 12 个**（四座 KB 级静态替身站，git clone 即可复现）+ **cross- 2 个跨站任务**。

### 3.1 三类补充用例（对标 WebArena + 补齐压测分桶）

在四站各自新增一个**设置页**（mini-admin `/admin/settings/`、mini-forum `/settings.html`、mini-gitlab `/settings.html`、mini-shopping `/customer/account/edit/`，均带登录守卫与顶栏入口）之后，补充了三类用例：

| 类别 | 用例 | 对标点 / 压测点 |
|---|---|---|
| 配置操作（settings，4 个） | 每站各 1 个 | WebArena「内容与配置操作」意图缺口：fill + 原生 select + click 保存 + 回显断言 |
| 跨页信息聚合（3 个） | admin 翻 3 页逐页 eval 统计 complete 单数后对照 dashboard（15/60/$26424.30）、shopping 评论面板 5 条聚合、forum 首页浏览量求和（3597） | WebArena「多页信息聚合」缺口 + eval 分桶样本 |
| 跨站任务（cross-site，2 个） | shopping 查 ugreen 价格 $6.99 → forum 发帖；gitlab 统计 10 个 issue → forum 发帖 | WebArena「跨站点组合任务」缺口：同一浏览器会话内多站点导航 + 信息传递（值由冻结数据静态推演） |
| eval/get/select 密集（3 个） | admin 订单页 DOM 三连 eval、gitlab 树节点 eval 统计、forum 成员搜索四连断言 | 压测分桶：指令动词样本量补齐（select 4→10、eval 4→23，runs=3 时均 ≥20 次/动词） |

### 3.2 与 WebArena 的关系：差异、对应性与评测价值

**数量对比**：WebArena 812 个任务 vs 本合集 54 个用例——表面差 15 倍，但两边评的东西不同：

| 维度 | WebArena（原版） | 本项目 |
|---|---|---|
| **评测目标** | Agent **能力**：任务完成率（比拼智能化水平） | 工具链**性能与稳定性**：指令延迟分布、吞吐、并发曲线 |
| **站点形态** | 真实动态站（GitLab/Magento/NodeBB 全栈部署，带数据库后端） | 同源场景的静态替身站：无后端，交互语义在页面层复刻 |
| **部署重量** | 官方镜像上百 GB，docker import + base_url 配置，状态重置繁琐 | 五个目录一个 HTTP 服务，秒级重启，`git clone` 即复现 |
| **确定性** | 动态状态易污染，同任务多次执行结果可能漂移 | 同用例重复执行结果确定一致（54/54、单用例 3/3 实测验证），重复压测数据干净 |
| **可压测性** | 动态站并发下行为不稳定，难以做干净的 c=2/4/8/16 梯度对比 | 静态服务抗并发（keep-alive 调优），瓶颈始终在被测工具链侧 |
| **评测口径** | 任务成功率单一口径 | **双成功率**：指令成功（rc==0）≠ 功能成功（终态断言），能暴露静默失败 |

**为什么 54 个用例能对应 812 个任务**（压测的方法论是抽样代表形态，不是穷举）：

1. **任务千变万化，指令原语只有 9 类**：812 个任务拆到底都是 open / click / fill / type / press / select / get / wait / eval 的序列组合，本合集全部覆盖且有密度分布——812 个任务中任何一条的执行负载形态都落在测过的指令组合空间内。
2. **平均步长同量级**：WebArena 任务平均约 6~8 步；本合集约 400 条指令 / 54 用例 ≈ 7~8 步，含跨站状态链。
3. **场景语义逐一对照**：mini-shopping ↔ Magento 237 任务族、mini-forum ↔ NodeBB 269 任务族、mini-gitlab ↔ GitLab 248 任务族、mini-admin ↔ 后台管理类、cross-* ↔ 跨对象协作任务。选择器与真实站同名（`#email`/`#pass`/`#send2`/`options[51745]`），数据值用 WebArena 标定点，可逐条核对。
4. **难度内核保留**：WebArena 中让工具实测翻车的机制（keydown-only 组件、懒渲染、静默验证、遮挡检查等，见第 4/5 节陷阱表与 [docs/agent-browser-commands.md](docs/agent-browser-commands.md)）被逆向复刻成可无限重复的基准用例——抽样抽的正是最难、最有代表性的部分，而非照抄凑数。

**评测价值（向客户说明的三句话）**：

1. 我们测的东西 WebArena 测不了：WebArena 回答"agent 行不行"，本基准回答"agent-browser 工具链在目标平台上跑得快不快、稳不稳、并发扛不扛得住"——正是鲲鹏 vs 海光/Intel 平台对比要的答案。
2. 环境噪声被控制到最低，差异才能归因到平台：真实动态站上 20s 的指令耗时可能有 15s 是后端/网络抖动，平台差异说不清；静态替身站把环境压成常量，跑出的并发梯度曲线就是工具链 + CPU + 系统的真实差距。
3. 静默失败有终态断言兜底：并发压力下出现输入失效、事件丢失等静默劣化能被双成功率抓出来，而非被 rc==0 的表面绿灯掩盖（实测确实抓出过 agent-browser 输入管线 bug）。

一句话版本：**用 WebArena 同源的场景语义做负载基准，把环境噪声变成常量，让平台间性能差异可测量、可复现、可归因。**

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
| mini-forum（8020） | NodeBB 论坛 | F1 发帖标签是自定义 div 下拉（选项点击 `#tag-dropdown-toggle` 后才懒渲染，`select` 指令无效）；F2 未登录点赞静默拦截（rc==0、票数不变）；contenteditable 富文本编辑器；普通 form GET 搜索作正常对照组 | 14 |
| mini-admin（8030） | Magento admin 后台 | A1 批量动作未选/未勾选时点 Apply 在处理器内静默 return；A2 delete 确认弹窗（`#confirm-modal`）点击 Apply 后才懒插入 DOM；60 单大表格分页 + 状态/客户/日期多条件组合筛选 | 12 |
| mini-gitlab（8040） | GitLab | G1 文件树逐层懒渲染（跳步点深层行必失败，须逐层展开）；G2 139 行长内容单条提取；G3 label 自定义 div 下拉（同 F1）；新 issue 空标题静默拦截 | 12 |

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
