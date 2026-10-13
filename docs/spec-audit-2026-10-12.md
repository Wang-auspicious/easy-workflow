# 从规格重新核对实现与运行环境

## 2026-10-13 复核：当前交付状态

本节核对版本为 `7bcc07c`。重新读取 [Spec](../Spec.md) 的 F3–F6、F8–F9、§5.2、§6–§9.5、§10.12、§11–§14、§26–§41，并对照当前执行路径、已有回归和隔离验收记录。下方 2026-10-12 的原始记录保留；其中“仍未交付”不再代表本版本状态。规格中带日期的历史盘点也不能代替当前代码事实。

本次只读代码与已有记录，不运行原项目、不启动模型，不重新执行测试。下表的“已落地”表示存在可调用实现及所列验证证据；不代表真实五站、30 站、账号平台或性能指标已经全部通过。

### 已落地的能力与具体边界

| 规格条款 | 当前实现与证据 | 仍需区分的边界 |
|---|---|---|
| F4.1、§6.1、§8.1–8.2：七条业务线 | [VisLexicon 包](../packs/vislexicon/pack.ts) 中，策展及 `components`、`atlas-feed`、`skills`、`sci-figure`、`ppt`、`image-fx` 均为 `wired:true`，并有实际执行器。新增六线由 [组件与图鉴工序](../packs/vislexicon/components.ts)、[媒体程序与审查定义](../packs/vislexicon/media-lines.ts) 接入：真实抓取/保留原件、组件取景、Python 绘图、逐页 deck 预览、图像前后处理和发布。既有 [业务集成回归](../test/business-integration.test.ts) 使用真实本地素材、浏览器及程序，审查回答为 fixture。 | 不能再写“六条线没有执行器”；也不能把 `wired` 或 fixture 审查当成六线真实业务质量全部达标。当前真实产物数量见下文。 |
| F4.2、§6.2：持久信道 | [ChannelSupervisor](../server/channels.ts) 已实现 `receive`、`pump`、`acknowledge`、`retryPlan`/`resumeChild`：发出、排队、创建下游和确认有持久记录；原子创建与投递、重放去重、旧库存迁移、父子身份隔离、失败从检查点继续、全局/局部暂停和有界入场均有 [channels 回归](../test/channels.test.ts)。组件完成后按持久游标继续下一批；图鉴 `flushAtlas` 由 [Factory.maintainRuntime](../server/factory.ts) 驱动，按 50 条或 5 分钟刷新。 | 已完成的上游和证据不因重投而从头重做；缺检查点的旧失败保留阻塞。不能由信道原子性推断任意外部工具恰好执行一次，未知副作用另由操作回执阻止盲重发。 |
| F4.3、§6.3、§26、§30.6、§41：共享配额 | [Broker](../server/broker.ts)、[Runtime](../server/runtime.ts) 与 [ModelRequests](../server/model-requests.ts) 共享实际资源边界；模型工位在途与真实请求分别限流。来源、信道和托管目录有界轮换；暂停保留排队。对应 [工位分配回归](../test/runtime-allocation.test.ts)、[Pi 回归](../test/pi.test.ts)、[适配器回归](../test/agent-adapter.test.ts) 和 [信道/来源回归](../test/channels.test.ts)。 | 新项目浏览器默认 8、上限 16，已有手工配额不被覆盖；这不等于 A2 的“三条线、30 分钟、配置为 3 页且内存达标”已经实测。原生不透明 CLI 只能按整次调用占槽，不能声称控制其内部全部 HTTP 并发。 |
| F9.1、F9.3、§9.5：项目级通用包 | [loadWorkflowPacks / installWorkflowPack / addWorkflowLine](../server/workflow-packs.ts) 从项目 `packs/installed.json` 及版本目录加载角色、schema、执行代码和条件；[Factory](../server/factory.ts) 启动/重载绑定同一 Runtime。安装先校验实际执行器、角色、schema、现有补丁及并行写冲突，再提交索引；结构变更只在结束且空闲时生效。[workflow-control 回归](../test/workflow-control.test.ts) 经真实控制面安装不含 VisLexicon 的包，投料生成可核验文件，重启后再次执行并保留原结果。 | 不是给固定策展线改名。通用包可复用调度、审查、证据和恢复，但新领域仍须提供自己的角色、契约与执行逻辑；缺执行器不能通过安装。 |
| F9.2、§9.5：模板与新增流水线 | [instantiateWorkflowTemplate](../server/templates.ts) 提供“生产+审查”“扇出汇总”“采集加工审查发布”“分流多线”四个完整模板，角色文件位于 [packs/templates](../packs/templates)。[控制工具](../server/control.ts) 已提供 `workflow_template`、`workflow_install`、`workflow_line`、`workflow_feed`；[Library](../ui/src/views/Library.tsx) 有实际创建、安装、新增线和投料界面。[workflow-packs 回归](../test/workflow-packs.test.ts) 覆盖四模板的具体程序、分支及退回；[浏览器回归](../ui/test/workflows-browser.mjs) 覆盖真实创建、重载和产物摘要。 | **空白画布拖出工位/连线并填写完整契约仍未实现。** 当前新增线使用结构化定义表单；已有主调度补丁审批不等于“任意新工作流的角色、代码与 Spec 一并起草，并以未生效图完整预览”已经交付。 |
| F3.1–F3.5、§7、§9.5、§41：配比与伸缩 | [Runtime.stationNumbers / resourceAllocations / balance](../server/runtime.ts) 记录到达与服务时间，按最近窗口和实际样本计算需求；[allocateResource](../server/allocation.ts) 按 `λ × s` 比例分配稀缺名额，保留审查位置。积压扩容、空闲撤员、防抖、手工锁定及可读调度说明已接入。`measurementProposal` 在十件独立任务后持久提出建议，`decideMeasurement` 支持接受/拒绝并保留锁与配额；[分配](../test/runtime-allocation.test.ts)、[跨重启控制](../test/runtime-control-persistence.test.ts) 和浏览器十件程序任务记录覆盖这些入口。 | 默认模式依照最新持续流动要求自动调整，不等待人工批准。十件后的**测量建议确认**是独立控制入口；§9.5 旧文的“初期每站 1 人、确认后才自动伸缩”属于旧约束，当前非默认，不能据此把默认自动扩缩列为缺陷或加审批门。没有十次工位样本时明确使用规格估计；真实吞吐与长时伸缩效果仍需业务日志验收。 |
| F5.2–F5.4：局部控制 | [Runtime.setScopePaused](../server/runtime.ts) 与 [run_control / workers](../server/control.ts) 已支持单线、单工位暂停/恢复及配员锁定；暂停状态持久保存，恢复整轮不清除局部暂停。已有 [运行控制持久化](../test/runtime-control-persistence.test.ts) 与 [实际调度](../test/runtime-allocation.test.ts) 验证其他线继续、目标队列保留及重启一致。 | 局部暂停阻止新派发，已经执行的工位可正常收尾；不能把暂停当作取消或撤销已发生的外部操作。 |
| F6.1–F6.4、§11、§29、§33–§34：证据与纠错撤销 | [EvidenceStore](../server/evidence.ts) 保留内容寻址证据；[Docs](../server/docs.ts) 保存案卷和工位来往；[Runtime.correct / undoCorrection](../server/runtime.ts) 原子保存纠错前数据、队列、检查点及库存。尚未执行的纠错可跨重启撤销；[持久化回归](../test/runtime-control-persistence.test.ts) 及浏览器纠错浮层命中、提交、重载撤销覆盖实际入口。 | 撤销只适用于未开始后续尝试的纠错，已执行项须另建纠错，不能还原已经发生的外部副作用。A5 的“证据板纠错到真实新图替换”和 A6 的逐字段业务抽查仍须单独验收。 |
| F8.0–F8.2、§6.6：持续来源闭环 | [SourceSupervisor](../server/sources.ts) 已实现明确 URL 的 RSS/Atom/Sitemap、JSON 和共享浏览器页面采集，固定间隔、重启逾期只补一次、持久候选/去重/领取/完成、作者历史通过率排序及平台限速。默认停用，无配置零任务；手动采集可只保存候选，自动投料须来源启用且运行未暂停。未解决候选上限 500、接口最近 50 加全量计数、HTTP 2MiB/共享配额、默认一件执行窗口均有 [来源回归](../test/channels.test.ts)。[控制面](../server/control.ts) 与 Library 实际表单已接入。 | 按 §6.6 的当前边界，尚无任意 cron，也未把动态来源映射为画布来源节点。预设 `sources/watch`、X、小红书等仍为休眠声明，未因新增调度器而自行激活；“20 个合集源”文案不证明已导入、逐个可采。 |
| F8.3、§6.0、§6.4–§6.5、§26、§36：平台与原始观测 | 浏览器来源复用 [共享 Browser](../server/browser.ts) 的现有会话，失败按当前页面证据处理，不填密码或自动登录。`SourceSupervisor.collect` 的 RSS/JSON 路径可保留输入提供的作者、时间、图片和摘录，来源/URL 去重与完成处置均持久保存。 | **浏览器路径目前只提取外链及页面摘录，不是 X/小红书/抖音/B站的完整帖子解析器。** 同来源同 URL 再次命中只累计重复数，不保存每次完整原文观测；新来源仅补 provenance。因此“每条原始观察保留”、帖子作者/时间/附图、多资源拆分与实体归并的完整平台闭环仍有差距，不能将通用来源 fixture 作为平台账号验收。 |

外部工具接入亦已越过占位阶段：[invokeWorkflowTool](../server/workflow-tools.ts) 支持包声明的 CLI、MCP、HTTP，[runDurableOperation](../server/operations.ts) 对可能写入的操作保存 `started/completed/uncertain`，完成结果可重用，响应丢失或旧 intent 未知时不自动重发。[既有工作流回归](../test/workflow-packs.test.ts) 覆盖本地 HTTP/CLI/MCP 和真实 Factory 的人工保留路径。该边界不涵盖任意可信 Node 模块自行绕过工具适配器执行的外部副作用。

### 已有实测记录能证明什么

- 完整工作流浏览器记录 `var/verification/workflows-ui/result.json` 为 `sourcesOnly:false`，保存 10 项检查、空 `errors`、十件测量样本和实际产物字节/摘要。它证明模板/安装/新增线、局部暂停、测量建议、报告入口、纠错撤销及来源表单连到真实后端；不证明全部真实业务审查成功。
- 私有隔离记录 `artifacts/live-all-lines-latest.json` 实际领取 **23 个网站任务，6 个 published、17 个 parked**；另外 Skills 为 **5 个 published、5 个 parked**，科研图为 **1 个 published、9 个 parked**。本次只读核对该隔离项目发布目录，分别存在 6、5、1 个相应 JSON 文件；组件、图鉴、PPT、图像处理没有该轮发布文件。记录总时长为 **7,201,595ms（约 120 分钟）**。`completed:true` 表示验收脚本结束，不是全部任务成功；运行超过 30 分钟也不证明三条线同时有效工作及资源曲线达标。
- [2026-10-11 真实站点记录](backend-handoff-results-2026-10-11.md) 已分别核验 Lucide 与 Carbon 的发布链。后续隔离轮中 Lucide 再次发布，另四个指定站点为 parked；这不抹掉 Carbon 的历史成功，也不能合并不同轮次来冒认当前五站全部通过。Magic UI 曾被独立目视发现目录不合格；Uiverse 验证墙、Laws of UX 网络问题及 Lucide 对照基线缺失均有历史记录，不能用程序测试消去这些验收问题。
- 后端状态摘要、历史分页/SSE 背压、报告 Worker、图片异步编解码及 Docs/信道/经验索引的内存改进，已有 [LangGraph 对照记录](langgraph-typescript-gap.md) 中的测量与回归。它们证明具体卡顿根因已修，不证明 N5 的 500 令牌 / 20 工位帧率。原生客户端按 [§41](../Spec.md) 分别记录：OpenCode 有受限真实节点验证；Codex/Claude 当前改动为静态协议和本地替身验收，不能写成已启动真实客户端。

以上私有记录不随公共仓库发布，本节只记录计数与可复核边界；没有复制个人绝对路径、凭据、会话内容或用户项目数据。

### 真正剩余的验收

| 条款 | 当前证据与尚需完成的判断 |
|---|---|
| A1、§38：30 网站与指定五站 | **未完成。** 需至少 30 个真实网站的可发布文件与 journal 对应；五站还须分别完成逐字段基线对照、图片人工抽查，以及耗时/真实模型调用/退回/直接沟通计数。23 个领取和 6 个 published 不能写成 30 站通过；缺基线不可拿旧样本替代。 |
| A2、N1–N2：持续多线与资源/吞吐 | **未完成完整验收。** 需同一连续 30 分钟内三条线实际运行的 Broker 页面/内存采样；按 A2 应显式使用 3 页配额，不能拿 §30.6 的新默认 8 页替换阈值。现有约 120 分钟汇总没有在本次复核形成这组逐时证据；也未证明 ≥120 站/小时。 |
| A3、A9、A13：伸缩与真实报告 | 算法、调度事件、实际中位数/P90/用量/耗时和结束回执已有实现，见 [Runtime](../server/runtime.ts)、[report](../server/report.ts)、[报告回归](../test/report-metrics.test.ts)、[结束/恢复回归](../test/recovery.test.ts)。仍需把同轮实际 fork/撤员及可读说明、配比/吞吐、库存前后 diff 和至少六项有数据支持的指标与真实 journal 对齐；不因 UI 能打开 fixture 报告就认定全部业务指标验收通过。 |
| A4、N3：恢复与不重复发布 | **已有自动化证据，不再列为“未实现”。** [原子日志](../test/journal-atomic.test.ts)、[断点重启](../test/runtime-restart.test.ts)、[存储故障](../test/runtime-storage-fault.test.ts)、[信道](../test/channels.test.ts) 及 [外部操作](../test/workflow-packs.test.ts) 覆盖具体崩溃窗口、恢复身份和未知回执。这不补造旧日志从未记录的状态，也不保证第三方任意写操作恰好一次。 |
| A5–A6、N4：纠错图与字段追溯 | **完整业务验收仍待补齐。** 当前纠错撤销浏览器回归不等于在证据板完成真实重拍、新图替换的录屏。发布门禁与引用绑定已有检查；任意新包/六条新业务线仍须按其真实最终字段抽查输入证据、产出工位及审查记录，不能只看 schema 合法。 |
| A7、A11、F9.2：结构与布局 | 包安装、新增线、补丁校验/生效和执行器缺失拒绝已有 [控制回归](../test/control.test.ts) 与 [工作流回归](../test/workflow-packs.test.ts)。本次未找到可把“删工位→加工位→恢复默认”及“拖动前后编译逐字节一致”两条完整步骤标为已验收的记录；重命名补丁和新增线测试不能代替它们。空白画布编排是另外的实际实现缺口。 |
| A8、N5：大画布性能 | **未完成。** 需要真实 500 令牌 / 20 工位场景的 ≥50fps 和事件到画布 ≤300ms 记录；历史页不再卡死、HTTP 变快和小图交互通过均不是这个指标。 |
| A10、N10、F8.3：平台账号 | **未完成真实平台验收。** 需由已授权用户会话证明 X 登录→重启后采集→主动退出→来源黄灯；其他平台逐个记录实际支持范围。共享 Cookie 的 fixture、可见浏览器和一般网页采集不等于平台账号已连接。 |
| A12：随仓库完整离线回放 | 已有 [分页回放与取消回归](../test/ui-report-activity.test.ts)，但当前版本未提交完整 journal 样本（已核对受跟踪的 JSONL/SQLite 文件）；[截图回放脚本](../scripts/shot-replay.mjs) 依赖本地已有服务和运行记录。尚需可随交付获得、不含私有数据且无需模型/浏览器采集/外网的完整回放材料及实测。 |

**最重要的下一步是完成 §38 的指定五站业务验收。** 从已有案卷、可用证据和真实失败工位继续核对，补齐缺失基线，逐项给出发布文件与字段/图片结论；保留访问墙和系统失败原因，不降低 gate，也不从头重做已经完成的付费步骤。完成这组质量基线后，30 站和持续多线指标才有可信的产物口径。

## 2026-10-12 原始审查（历史记录）

本次以 `Spec.md` 为起点，结合“审查 H2 spec 与实现差距”中的原始问题核对当前实现。后追加的 §26–§39 优先于前文旧布局、配额和恢复描述。此前隔离项目的成功不作为当前项目已发布的证据。

### 本次查明并修复的问题

| 规格依据 | 可复现的问题 | 修复与回归 |
|---|---|---|
| F2.5、§11–12、§29、§34 | 直接修复与嵌套修复只存在内存；重启后跳过责任工位、提前复查旧字段，或停在已完成但未排后继的缝隙 | 持久保存真实完成集、修复父链、待处理修复与轮数；工位回执和调度决定在一个事务提交，提交后再通知投影。`journal-atomic.test.ts`、`runtime-restart.test.ts` |
| §28–29、§33、§39 | 候选重试把 `ok:true` 的“要求修复”误当完成；模型中断丢失修复指令；转人工不取消旁支；存储回滚后还能继续使用污染内存 | 按精确检查点恢复并保留修复原因，终态回收同任务工作；存储故障阻止原进程继续，重启后从已提交日志重建。`runtime-retry-checkpoint.test.ts`、`runtime-storage-fault.test.ts` |
| §28、§30.3 | HTTP 等待名额和 429 退避不及时响应取消；相同 URL 的不同请求表示串用缓存 | 有序、可取消的限流；请求头参与缓存键；认证及禁止缓存的响应不落盘。`network-queue.test.ts` |
| §30.5 | 使用代理时仍要求本机解析目标域名；体检详情可能包含代理路径；截图超时后的迟到页未回收 | 检查实际网络下一跳、隐藏代理凭据和路径、给截图操作传递取消并回收。`preflight-network.test.ts` |
| §26、§30.2 | 独立服务不恢复用户标签，没有周期性登录检查，与桌面端行为不同 | 恢复标签及顺序、只保存用户页、登记用户弹窗、每 30 秒检查空闲页。`browser-standalone.test.ts` |
| §26、§28 | 关闭页面等待的是导航前的检查，可能销毁新登录现场；连接 CDP 时取消延迟；30 个标签只恢复 20 个 | 释放前检查当前页面、连接阶段响应取消、保存并恢复完整上限。`browser-check-race.test.ts`、`browser-lease-cancel.test.ts` |
| §29、§34、§35 | 终审 JSON 被硬截到 14,000 字符；仲裁只验证引用文字而未绑定来源；“通过”可同时包含未解决问题 | 终审接收完整记录和事实原文；完整来源绑定；逐张图片审查；通过与未解决问题互斥。`station-contracts.test.ts` |
| §29、§36 | `#/` 与 `#!/` 内容路由被当作普通锚点删除，不同页面混用证据 | 保留内容路由和查询参数，事实及仲裁核验同一来源。`network-queue.test.ts`、`station-contracts.test.ts` |
| F2.4、§30.4 | 缺失图片被静默移出模型输入；自动修剪可绕过原始输出契约 | 缺图立即返回可恢复原因且不调用模型；修剪后重新验证 schema 和业务条件。`station-safety.test.ts` |
| §30.1、N7 | 明确指定独立 profile 后仍读取不可用的系统用户目录，Windows 启动崩溃 | 显式 profile 直接决定路径；独立桌面烟测覆盖实际启动、重启与只读查看 |
| §39 | 收起聊天会卸载输入框，丢失未确认消息的请求 ID 和送达模式；收起后快捷键失效 | 收起只隐藏视图，保留请求身份和模式；快捷键在展开与收起状态均可用。`ui/test/chat-browser.mjs` |
| §31、§37 | 闭源工位的 CONTEXT 仍称使用 Pi，混淆配置模型与实际回执 | 分别显示适配器、请求配置和最近执行回执；程序节点如实标注。`docs.test.ts` |
| N1、验收可信度 | 全量测试不限制并行，浏览器争用内存；两份测试在导入浏览器模块后才设置隔离目录 | 默认串行测试；浏览器导入前设置项目并断言真实 profile 位置；`typecheck` 同时检查服务与界面 |

### 当时仍未交付的规格能力

下表保留 2026-10-12 当时的缺口记录，其中“当前”指当日。2026-10-13 的实现与验收状态以上文复核为准。

| 规格 | 当前实现与缺口 |
|---|---|
| F4、§6、§8.1–8.2 | 候选处理与策展为 `wired:true`；其他六条业务线和来源层尚未接入执行器。信道有发出事件与库存统计，缺下游消费、确认与去重投递闭环 |
| F9、§9.5 | 运行时和编译器有包结构，但 Factory 仍加载固定预设；缺通用包安装、新增流水线和真正的模板实例化。流水线库按钮实际只起草对话，本轮已将其标为流程设计参考，移除“点击即可创建”的暗示 |
| F3、§7 | 已计算服务时间、到达率和建议人数，也有积压扩容与空闲撤销；仍缺按 `λ × s` 分配稀缺资源，以及首次十件测量后确认建议的完整流程 |
| F5、F6 | 当前具备整轮启停、工人数调整、纠错与恢复；单线／单工位暂停和纠错撤销尚未完成 |
| F8、§6.4–6.6 | 登录会话与标签管理可用；定时社媒来源采集、平台限速计划与作者信誉排序尚未形成运行闭环 |
| A1、A2、A8、§38 | 30 个真实网站、多线 30 分钟、500 令牌 50fps、指定五站全部产出并逐字段验收，仍不能由单元测试和桌面烟测代替 |

### 当时已核实的环境与数据口径

- Windows / Node 24：全量 `npm test` 共 342 项，341 通过、0 失败、1 项在未连接领域资料时跳过；连接真实 VisLexicon 规则后 `environment.test.ts` 的 12 项全部通过，包含此前跳过的 v3 校验。独立 HTTP 服务、MCP、鉴权、项目隔离定向检查 25 项通过；UI 单元检查 18 项通过。
- 源码 Electron：无模型凭据、无连接资料的独立 profile 可以启动；原生浏览器、后台截图与录屏、保留登录现场、书签与历史重启、只读日志保护、退出清理通过。项目菜单切换与 `page_text` / `page_find` 的原生浏览器检查通过。
- 便携版：重建后，`desktop-smoke.mjs --packaged --standalone` 与 `desktop-project-smoke.mjs --packaged` 均通过。UI 聊天和工位浏览器检查通过，前后端类型检查通过。
- 实际配置的 `opencode-go/muse-spark-1.3-contributor` 返回完整模型体检回答；应用内主调度和外部 Pi CLI 均通过真实的工具发现、只读调用及回执配对检查。这些检查不自动解除批次故障保护，也不证明先前其他模型通道已经稳定。
- 对原项目只读核对时，原轮次处于暂停状态，3 件仍在途，没有未关闭的直接修复会话。确认没有正在执行的调用后，将工作台正常关闭并以新便携版重启；再次核对轮次、暂停状态、任务数及已发布任务身份均保留。本次测试使用隔离项目，不将测试发布文件计入原项目，也不自动恢复原批次。
- 新版原项目的七项体检全部通过：DNS／代理、外网、模型、后台截图、项目存储、内存及登录状态。此前模型故障保护保持开启，继续原轮次后仍须先用一个实际工位验证恢复。
- **真实完整样本：** 便携包自带的 Electron Node 24.21.0、打包 SDK 和打包规则在新建隔离项目执行 Lucide，从候选、侦察、阅读、双人分类、编目、三角色采集、事实／截图／文案审查，到组装、终审、发布闸门全部完成，生成 `published/lucide.dev.json`。该轮 23 个工位尝试、0 次失败，从开始到发布 400 秒。人工查看目录图和特写图，二者分别呈现图标集合及选定的 activity 图标。该结果只属于隔离验收项目，未接回原库；不代替 §38 的完整五站验收，也不将单样本耗时外推为吞吐达标。

可重复执行的验证命令：

```powershell
npm test
npm run test:ui
npm run typecheck
npm run test:ui:browser
# 设置 VISLEXICON_ROOT 后补验真实规则
node --test test/environment.test.ts
npm run build
node scripts/package.mjs --no-build
node scripts/desktop-smoke.mjs --standalone
node scripts/desktop-project-smoke.mjs
node scripts/desktop-smoke.mjs --packaged --exe=release/EasyWorkflow-win32-x64/EasyWorkflow.exe --standalone
node scripts/desktop-project-smoke.mjs --packaged --exe=release/EasyWorkflow-win32-x64/EasyWorkflow.exe
# 以下检查使用实际模型，有少量模型用量
node scripts/check-pi-live.mjs
```

具体机器路径、私有项目记录和原始输出留在忽略的 `artifacts/` 目录；公开记录只保留检查方法、结果与限制。

旧版日志没有记录的修复父链与 `via` 不能无损补造。当前原项目没有旧版未关闭的直接修复会话；本轮回归验证新检查点和已有历史迁移场景，不宣称所有从未记录过的历史修复意图都能自动恢复。
