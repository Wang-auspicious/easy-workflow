# Easy Workflow：LangGraph 与 Google TypeScript 对照

核查日期：2026-10-12，持续更新本轮落地结果。初始代码基线为 `672d8d3`，下列已实现项包含随后工作区改动。“已有”表示可以定位的实现，不代表本轮重新完成了所有环境验收。代码行号供定位，后续以符号名为准。

结论：保留现有 Journal / Runtime / Broker，优先把内存、外部副作用、并发写入和执行器恢复契约补齐。现在替换整个引擎会扩大迁移范围，无法直接解决历史页卡顿或外部命令重复执行。

资料只使用 LangChain 官方 JavaScript/TypeScript 文档及 Google 官方 TypeScript 指南。按 agent-reach 网页路由和 web-access 静态获取指引读取，Jina 仅用于提取官方正文；没有打开用户浏览器、读取登录态或操作原项目。旧 `durable-execution` URL 本次重定向到 `persistence`，因此下面引用实际页面。没有安装 LangGraph，也没有用 Python 示例推断 TypeScript 能力。

## 已有能力、真实差距与优先级

| 能力 | 官方依据 | 当前仓库证据 | 差距与实现优先级 |
|---|---|---|---|
| 持久执行与检查点 | [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) 区分步骤快照与已完成节点的中间写入；失败恢复可以复用已完成节点 | [journal.ts](../server/journal.ts) `atomic/publish`：事务提交后投影和通知；[runtime.ts](../server/runtime.ts) `checkpoint/restoreCheckpoint/finishAttempt/haltForStorage`；[factory.ts](../server/factory.ts) `restore` 重建分支前沿；已有原子性、重启、存储故障回归 | **已有核心能力，不能列为“未实现”**。P0 保持日志提交失败后原进程停止的约束。工位内一次外部调用成功、工位结果未落盘的窗口另列为副作用问题，不能用工位检查点掩盖 |
| 外部副作用与重试 | [Graph API：节点重执行及任务](https://docs.langchain.com/oss/javascript/langgraph/graph-api#re-execution-and-idempotency) 和 [Interrupts：副作用](https://docs.langchain.com/oss/javascript/langgraph/interrupts#side-effects-called-before-interrupt-must-be-idempotent) 要求关注节点重执行；中断前的写操作可能重做 | **本轮已实现**：[operations.ts](../server/operations.ts) 复用 Journal 与 Dispatcher 操作阶段，保存 started/completed/uncertain 回执；[workflow-tools.ts](../server/workflow-tools.ts) 保护 POST、CLI 和缺少只读声明的 MCP tools/call；[workflow-packs.ts](../server/workflow-packs.ts) 绑定任务、工位及安装/契约版本 | 同输入/版本的失败重试沿 retryOf 根或 channelDelivery 复用稳定键；已完成结果按日志 seq 读取，未知结果停止为 manual，不重发、不误删候选。GET 和 readOnlyHint=true 的 MCP 正常读取。本地 CLI 配置、输入、工作目录错误在 intent 前检查。**余项**：远端结果查询/对账与明确恢复契约；本实现不宣称远端 exactly-once，也不伪造已核对结果 |
| 历史读取、流式更新与背压 | [Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) 区分增量更新、全状态和消息流；[Event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming) 提供按类型消费的投影。本次读取的页面没有承诺本应用 HTTP 慢客户端缓冲有界 | [main.ts](../server/main.ts) `/api/journal` 已有分页、固定 through、`drain` 等待；[journal.ts](../server/journal.ts) `readPage` 上限 500；[report-reader.ts](../server/report-reader.ts) 使用单 Worker、相同报告合并请求和 3 项缓存。**SSE 有界追赶/慢读处理本轮也已由主 agent 实现** | 主 agent 的隔离验收：35MB、30,013 条日志追赶期间并行 HTTP 约 13.6ms；慢读连接最大 writableBuffer 为 17,444 bytes，并按 deadline 释放，16 项相关回归通过。这是该样本结果，不能当任意日志规模的 SLA。全量状态只用于初始化，普通更新继续传增量；Worker 移走计算并不自动减少数据驻留 |
| 运行内存与长期记忆 | [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 将线程状态与跨线程 Store 分开，并提示检查点增长问题；[Stores](https://docs.langchain.com/oss/javascript/langgraph/stores) 面向有命名空间的应用记忆。这与进程 RAM 上限不是同一个问题 | **本轮已移除两处冗余驻留**：Channels 不再长期复制全部 token.data；[docs.ts](../server/docs.ts) 将 caseEvents 原始对象改为 caseSequences 数字索引，案卷经 [journal.ts](../server/journal.ts) `readSequences` 按需读取。Factory/共享投影仍保存历史任务索引；会话已外置文件 | 主 agent 在相同 38,237 事件、51 案卷的独立进程中，GC 后测得 **Docs 索引新增保留堆** 从 38.19MiB 降至 0.40MiB，案卷 digest 一致；这不是总 RSS。P1 继续做状态快照、活跃/结束任务冷热分层，以及会话文件按引用/字节预算回收；不删除可恢复检查点或审计日志 |
| 有界并发与持续补料 | [RunnableConfig](https://reference.langchain.com/javascript/langchain-core/runnables/RunnableConfig) 声明 `maxConcurrency`；这只是调用并发上限，不是浏览器、模型、HTTP 和 UI 缓冲的统一预算 | [broker.ts](../server/broker.ts) 管实际资源与取消；[batch.ts](../server/batch.ts) 管托管入场；[channels.ts](../server/channels.ts) 最多一个在途信道子任务。**本轮 [sources.ts](../server/sources.ts) 已接入真实 Factory 生命周期与资料库 UI**：显式配置 RSS/JSON/共享浏览器来源，持久去重、访问配额、500 件未解决候选上限、最多 50 件状态预览，从合法入口逐件投料 | 来源默认停用；启用后仍服从全局/局部暂停、模型阻塞和托管目标。执行名额只统计真实排队/运行任务，manual/parked 不会永久占据名额；已领取总量仍计入本轮目标。正常运行、终态先于 delivered、重启与事务失败、认证/超时隔离均有既有文件中的回归；完整浏览器操作链通过。**余项**：统一手动投料、来源与信道的 admission 指标，以及通用包持久恢复策略。来源验收使用真实本地 HTTP/浏览器 fixture，不代表原项目已启用公共来源或持续产出 |
| 重试、超时与故障处理 | [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) 将节点超时、可配置重试和耗尽后的处理分开；取消信号不应进入重试循环 | [shared/failures.ts](../shared/failures.ts) 分类归责；[batch.ts](../server/batch.ts) 有退避及单任务恢复试探；[agent-station.ts](../server/agent-station.ts) 区分工位预算、单次模型请求和有限修复；外部工具各自有 timeout | **P1：从内置业务专用恢复，抽成包可声明策略**。声明失败标签、最大次数、退避/抖动、总 deadline 和耗尽去向，次数及下一次执行时间落盘。系统短暂错误自动恢复；凭据/权限问题只停相应依赖；质量失败进入修复支路。Node 模块执行器只有协作式 AbortSignal，不能把同步死循环包装成可强制取消；需要硬隔离时使用 Worker/子进程执行器 |
| 人工输入与少打扰 | [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 将中断 payload、恢复值和持久身份关联；[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph#handle-errors-appropriately) 区分系统可恢复、模型可修复和用户可处理的问题 | [runtime.ts](../server/runtime.ts) `setScopePaused/openConsult/consultResult/toManual` 已有范围暂停及岗位间修复；[agent-station.ts](../server/agent-station.ts):152 有有限程序反馈修复；但 `StationSpec` 没有通用 typed pending-input / resume-value 契约，`manual` 主要还是终态与原因字符串 | **P1：人工只接真正需要外部输入的节点**。将缺字段、授权、登录、质量修复耗尽分别编码；pending input 带任务、工位、问题 ID、响应 schema 和允许选项，恢复值去重落盘。通过确定性检查的常规产物继续流转；证据不足不能靠模型自报“通过”跳过。沿用已有结构修改边界，不给每次工具失败加确认弹窗 |
| 并行状态合并 | [Graph API：Reducers](https://docs.langchain.com/oss/javascript/langgraph/graph-api#reducers) 明确每个状态字段的更新/合并语义 | **本轮已实现编译保护**：[workflow-packs.ts](../server/workflow-packs.ts) / [compile.ts](../server/spec/compile.ts) 拒绝可并行的同 outputKey 写入，安装/重载/已接受补丁和跨包 flow 均参与检查；顺序覆盖、不同字段和独立子任务仍允许 | 现有 `test/workflow-packs.test.ts` 的 3 项定向回归覆盖该边界。剩余 reducer 能力按业务需要增加，不用最后完成者覆盖来模拟合并，也不把所有同名字段一概禁止 |
| 子图/子任务 | [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) 区分每次调用隔离与跨调用保留状态，并用 checkpoint namespace 表达嵌套边界 | [channels.ts](../server/channels.ts) 有独立 delivery / child token、输入清洗、ack、续批；[shared/project.ts](../shared/project.ts) `tokenWorkKey` 区分父子同 item；项目 Pack 有持久角色/schema/代码版本 | **已有跨线异步任务，不等于通用嵌套子图**。P2 才补父任务等待子任务集合、取消传播、聚合规则、并行调用命名空间。不要为对齐术语改掉可靠的持久信道，也不要直接把父 checkpoint 复制给独立子任务 |
| 时间旅行与可复现性 | [Use time-travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel) 的 replay 会重新执行所选检查点之后的节点，fork 会产生新分支；模型及外部请求可能再次发生 | UI 已有只读事件回放；[runtime.ts](../server/runtime.ts) `correct/undoCorrection` 保存纠错快照、撤销未执行纠错；没有任意历史 checkpoint fork 到独立运行的公共 API | **P2：先明确“回看”与“重新执行”**。目前回看不产生新副作用，应继续保持。需要实验分支时给新 run/工作身份、父 checkpoint 和包版本，展示将重跑的节点与外部写影响；不要把拖动时间轴做成重新发布 |
| 闭源 Agent / Claude Code 等节点 | [Streaming：任意模型](https://docs.langchain.com/oss/javascript/langgraph/streaming#use-with-any-llm) 允许将任意客户端的进度经 custom 流发出；框架接口不能证明某个厂商 CLI 已实际兼容 | **本轮 [claude-code.ts](../server/claude-code.ts) 已实现官方 CLI adapter**，经 [mcp-station.ts](../server/mcp-station.ts) 限定为当前工位 MCP 工具，保存厂商 session、项目内工作目录及已读取证据；取消与重启保留 host checkpoint，恢复不重做已持久步骤。原 Pi 路径保持默认，显式环境变量选择闭源 adapter | **真实 Claude Code 2.1.220 验收通过**：结构化 submit、真实模型与用量、跨 token 恢复同一会话并绑定新工具作用域。实测修正了新工作目录无法找到旧会话，以及 CLI 每个进程费用被误当累计费用的问题。已有 adapter/security 回归覆盖；不是只用 fixture 宣称兼容。**P1 余项**：目前选择仍为全局环境变量，项目设置与单节点 adapter/model 绑定尚未落地；能力、会话签名和配置边界需保持显式，不能靠临时修改全局环境变量模拟同图多 adapter |

## Google TypeScript 在本仓库的落点

[Google 官方 TypeScript 指南](https://google.github.io/styleguide/tsguide.html) 支持本轮采用的重点是：具名导出、`const` 优先、每次声明一个变量、稳定成员使用 `readonly`、边界数据使用 `unknown` 并缩窄、异常使用 `Error`、保持代码可读。该指南开篇也说明其内部环境约束未必适用于外部项目。

当前 `tsconfig.json` 已启用 strict，但这不能验证来自 JSON、MCP、CLI 的运行时数据。`workflow-packs.ts` 的 `record`、`builtin`，`mcp-station.ts` 的 `StationTool.execute`，`main.ts` 的 body 边界仍有 `any`；优先在这些边界建立窄类型与 schema 解码，避免把断言当检查。压在同一行的声明、分支和清理代码，应在修改该函数时展开，尤其是事务和取消处理。

仓库采用 `NodeNext`、原生 `.ts` 加载与 `erasableSyntaxOnly`。**不要机械套用指南的 constructor parameter property 示例**，也不要为格式统一改掉 Node 入口、外部包必须的 default import 或当前 schema 库。格式与类型边界改造不应和恢复状态机的大范围改写混成一个提交。当前 package scripts 没有专用 lint 检查；后续可逐模块启用规则，先处理边界类型和清理路径，不以全仓格式化制造与现场修复无关的 diff。

## 可直接使用的实现约束

这些是本仓库的设计建议，不是 LangGraph 的兼容 API：

- **副作用记录**：`operationId + workIdentity + nodeRevision + inputHash + phase + remoteReceipt`。跨重试保留操作身份；结果未知时先核查，不能由超时直接推导为未执行。
- **人工输入记录**：`interruptId + token + node + reasonCode + responseSchema + response + resumedAt`。缺输入与工具故障分开；同一响应不可重复推进两次。
- **执行器能力**：`adapterId + supportedTools + stream + cancel + resume + usage`，不支持的能力明确为 false/unknown，不用统一包装伪造支持。
- **资源可见性**：并发名额、内存预算、持久队列、客户端缓冲分别计数；后台继续执行不依赖界面是否打开。
- **缓存边界**：原始证据和产物可按摘要复用；不同包版本、职责/schema 变化、修复理由变化必须参与失效。发送、发布等动作需要操作回执，不能简单用读取缓存代替。

官网的 durability 模式不是要求本地应用切换数据库。本地 SQLite 的事务恢复与分布式服务的存储/租约需求不同；本轮不新增数据库或消息队列，也不把 LangGraph 的 super-step 强加给当前事件驱动流水线。上述建议均可逐项落在现有模块。

## 本轮已落地及复用验收

图片编解码已从服务线程同步调用迁到共享异步子进程池，覆盖网站处理、截图拼接/检查/补边、组件、PPT、科研绘图、图像效果、风格像素统计、Pi/闭源工位与主调度图片输入。真实入口的同素材对照中：3 张图的网站处理期间，HTTP 最长延迟由约 1.52–1.60 秒降至 12–24 毫秒；10 页 PPT 由约 3.51–3.72 秒降至 21–27 毫秒。WebP 输出和感知哈希逐字一致。这是隔离测试样本，未推断 500 页结果或任意机器的延迟保证。

异步池固定单进程，排队、运行取消、超时、输出上限和名额恢复都在既有 environment 回归中验证；工位/主调度复用既有 35 项会话回归，覆盖准备图片时取消、恢复原会话、迟到的 steer 图片只投递一次。风格检查按 attempt 预计算像素统计，缺证据或校验库必须失败，不能用空校验结果放行。真实发布仍需完整业务门禁；这些测量不能记作用户项目的新增产出。

首轮完成 [channels.ts](../server/channels.ts) 的数据驻留修复：只在构造回放期间临时合并 token.data，回放结束释放；实时在 `channel.emitted` 的投影时刻读取 Factory 状态并复制所需消息，不再长期保存每个 token 的第二份完整数据，也不再每次 token.data 对整个记录做 spread。消息快照、重放去重、检查点重试和低并发行为保持原契约。

- `node --test --test-concurrency=1 test/channels.test.ts`：10/10 通过，约 7.3 秒；覆盖同批快照、三类崩溃窗口、旧库存、暂停、跨重启复用结果和证据、父子身份、有限组件续批。
- `npx tsc -p tsconfig.json --noEmit`：通过。
- 本轮没有新增测试文件；没有测量具体 RSS 降幅，不将运行时长差异当内存或性能收益证据。

随后外部副作用回执在同一 `test/workflow-packs.test.ts` 中完成本地 HTTP/CLI/MCP 与真实 Factory 验收。先复现响应丢失、重启重投导致外部写入两次，再验证：提交 intent 前禁止 I/O；completed 跨重启复用；started/uncertain 不重发；失败落盘仍保留 intent；多次 retry 与信道子任务身份稳定；输入或版本变化分别判定；GET/已声明只读 MCP 保持读取；本地配置失败不制造 unknown；取消重复等待者不取消原执行者；Runtime 将未知结果保留 manual 并取消旁支，重启和显式纠错不重发。回执阶段沿用 Dispatcher 的 `uncertain` 词汇，对用户显示“结果未知”。

| 后续改动 | 复用已有回归 | 必须证明的结果 |
|---|---|---|
| SSE / 历史读取 / 内存 | `test/report-responsive.test.ts`、`test/journal-atomic.test.ts`、`test/ui-report-activity.test.ts` | 慢读/断开后后台仍响应；游标不丢不重；读取范围固定；取消释放缓存和等待者 |
| 外部副作用回执 | `test/workflow-packs.test.ts`、`test/runtime-storage-fault.test.ts` | 模拟外部已执行但本地未提交，重启先查结果，不重复调用 |
| 并行写冲突 | `test/workflow-packs.test.ts` | 并行同键拒绝；顺序覆盖/独立字段仍可运行；不受完成顺序影响 |
| 少打扰与恢复策略 | `test/station-safety.test.ts`、`test/runtime-retry-checkpoint.test.ts`、`test/runtime-restart.test.ts` | 程序可确认的修复自动继续；认证/未知副作用保留明确问题；取消不重试，修复预算跨重启保留 |
| 闭源节点选择与恢复 | `test/agent-adapter.test.ts`、`test/mcp-security.test.ts` | 同图可选不同 adapter；重启恢复正确会话；作用域与取消保留；实际模型/用量缺报保持未知 |

文档中的 P0/P1/P2 是缺陷影响和依赖关系的排序，不是另建开发流程。历史卡顿修复及持续低并发产出优先；资料不支持的能力不列为已交付。
