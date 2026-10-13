# Easy Workflow：LangGraph 与 Google TypeScript 对照

核查日期：2026-10-13，持续更新本轮落地结果。初始代码基线为 `672d8d3`，下列已实现项包含随后工作区改动。“已有”表示可以定位的实现，不代表本轮重新完成了所有环境验收。代码行号供定位，后续以符号名为准。

结论：保留现有 Journal / Runtime / Broker，优先把内存、外部副作用、并发写入和执行器恢复契约补齐。现在替换整个引擎会扩大迁移范围，无法直接解决历史页卡顿或外部命令重复执行。

资料只使用 LangChain 官方 JavaScript/TypeScript 文档及 Google 官方 TypeScript 指南。按 agent-reach 网页路由和 web-access 静态获取指引读取，Jina 仅用于提取官方正文；没有打开用户浏览器、读取登录态或操作原项目。旧 `durable-execution` URL 本次重定向到 `persistence`，因此下面引用实际页面。没有安装 LangGraph，也没有用 Python 示例推断 TypeScript 能力。

## 已有能力、真实差距与优先级

| 能力 | 官方依据 | 当前仓库证据 | 差距与实现优先级 |
|---|---|---|---|
| 持久执行与检查点 | [Checkpointers](https://docs.langchain.com/oss/javascript/langgraph/checkpointers) 区分步骤快照与已完成节点的中间写入；失败恢复可以复用已完成节点 | [journal.ts](../server/journal.ts) `atomic/publish`：事务提交后投影和通知；[runtime.ts](../server/runtime.ts) `checkpoint/restoreCheckpoint/finishAttempt/haltForStorage`；[factory.ts](../server/factory.ts) `restore` 重建分支前沿；已有原子性、重启、存储故障回归 | **已有核心能力，不能列为“未实现”**。P0 保持日志提交失败后原进程停止的约束。工位内一次外部调用成功、工位结果未落盘的窗口另列为副作用问题，不能用工位检查点掩盖 |
| 外部副作用与重试 | [Graph API：节点重执行及任务](https://docs.langchain.com/oss/javascript/langgraph/graph-api#re-execution-and-idempotency) 和 [Interrupts：副作用](https://docs.langchain.com/oss/javascript/langgraph/interrupts#side-effects-called-before-interrupt-must-be-idempotent) 要求关注节点重执行；中断前的写操作可能重做 | **本轮已实现**：[operations.ts](../server/operations.ts) 复用 Journal 与 Dispatcher 操作阶段，保存 started/completed/uncertain 回执；[workflow-tools.ts](../server/workflow-tools.ts) 保护 POST、CLI 和缺少只读声明的 MCP tools/call；[workflow-packs.ts](../server/workflow-packs.ts) 绑定任务、工位及安装/契约版本 | 同输入/版本的失败重试沿 retryOf 根或 channelDelivery 复用稳定键；已完成结果按日志 seq 读取，未知结果停止为 manual，不重发、不误删候选。GET 和 readOnlyHint=true 的 MCP 正常读取。本地 CLI 配置、输入、工作目录错误在 intent 前检查。**余项**：远端结果查询/对账与明确恢复契约；本实现不宣称远端 exactly-once，也不伪造已核对结果 |
| 历史读取、流式更新与背压 | [Streaming](https://docs.langchain.com/oss/javascript/langgraph/streaming) 区分增量更新、全状态和消息流；[Event streaming](https://docs.langchain.com/oss/javascript/langgraph/event-streaming) 提供按类型消费的投影。本次读取的页面没有承诺本应用 HTTP 慢客户端缓冲有界 | [main.ts](../server/main.ts) `/api/journal` 已有分页、固定 through、`drain` 等待；[journal.ts](../server/journal.ts) `readPage` 上限 500；[report-reader.ts](../server/report-reader.ts) 使用单 Worker、相同报告合并请求和 3 项缓存。**SSE 有界追赶/慢读处理本轮也已由主 agent 实现** | 主 agent 的隔离验收：35MB、30,013 条日志追赶期间并行 HTTP 约 13.6ms；慢读连接最大 writableBuffer 为 17,444 bytes，并按 deadline 释放，16 项相关回归通过。这是该样本结果，不能当任意日志规模的 SLA。全量状态只用于初始化，普通更新继续传增量；Worker 移走计算并不自动减少数据驻留 |
| 运行内存与长期记忆 | [Persistence](https://docs.langchain.com/oss/javascript/langgraph/persistence) 将线程状态与跨线程 Store 分开，并提示检查点增长问题；[Stores](https://docs.langchain.com/oss/javascript/langgraph/stores) 面向有命名空间的应用记忆。这与进程 RAM 上限不是同一个问题 | **本轮已移除两处冗余驻留**：Channels 不再长期复制全部 token.data；[docs.ts](../server/docs.ts) 将 caseEvents 原始对象改为 caseSequences 数字索引，案卷经 [journal.ts](../server/journal.ts) `readSequences` 按需读取。Factory/共享投影仍保存历史任务索引；会话已外置文件 | 主 agent 在相同 38,237 事件、51 案卷的独立进程中，GC 后测得 **Docs 索引新增保留堆** 从 38.19MiB 降至 0.40MiB，案卷 digest 一致；这不是总 RSS。P1 继续做状态快照、活跃/结束任务冷热分层，以及会话文件按引用/字节预算回收；不删除可恢复检查点或审计日志 |
| 有界并发与持续补料 | [RunnableConfig](https://reference.langchain.com/javascript/langchain-core/runnables/RunnableConfig) 声明 `maxConcurrency`；这只是调用并发上限，不是浏览器、模型、HTTP 和 UI 缓冲的统一预算 | [broker.ts](../server/broker.ts) 管实际资源与取消；[batch.ts](../server/batch.ts) 管托管入场；[channels.ts](../server/channels.ts) 最多一个在途信道子任务。**本轮 [sources.ts](../server/sources.ts) 已接入真实 Factory 生命周期与资料库 UI**：显式配置 RSS/JSON/共享浏览器来源，持久去重、访问配额、500 件未解决候选上限、最多 50 件状态预览，从合法入口逐件投料 | 来源默认停用；启用后仍服从全局/局部暂停、模型阻塞和托管目标。执行名额只统计真实排队/运行任务，manual/parked 不会永久占据名额；已领取总量仍计入本轮目标。正常运行、终态先于 delivered、重启与事务失败、认证/超时隔离均有既有文件中的回归；完整浏览器操作链通过。**余项**：统一手动投料、来源与信道的 admission 指标，以及持续入场下网络恢复的公平性。来源验收使用真实本地 HTTP/浏览器 fixture，不代表原项目已启用公共来源或持续产出 |
| 重试、超时与故障处理 | [Fault tolerance](https://docs.langchain.com/oss/javascript/langgraph/fault-tolerance) 将节点超时、可配置重试和耗尽后的处理分开；取消信号不应进入重试循环 | [shared/recovery-policy.ts](../shared/recovery-policy.ts) 验证工位/执行绑定的声明；[recovery.ts](../server/recovery.ts) 在同一恢复监督器中保存策略、次数、退避/抖动、总期限与耗尽去向；[runtime.ts](../server/runtime.ts) 捕获每次尝试的策略并传递期限取消。未声明策略保留既有规则 | **声明式策略已有实现**。模型服务冷却与任务预算分别生效，策略不能重试认证、取消或结果未知的外部操作。进程内模块仍仅支持协作式 AbortSignal，不能强制终止同步死循环；需要硬隔离时使用 Worker/子进程执行器。持续入场下网络恢复的公平性仍需单独补齐，不由“有重试策略”推导为不会饿死 |
| 人工输入与少打扰 | [Interrupts](https://docs.langchain.com/oss/javascript/langgraph/interrupts) 将中断 payload、恢复值和持久身份关联；[Thinking in LangGraph](https://docs.langchain.com/oss/javascript/langgraph/thinking-in-langgraph#handle-errors-appropriately) 区分系统可恢复、模型可修复和用户可处理的问题 | [runtime.ts](../server/runtime.ts) `setScopePaused/openConsult/consultResult/toManual` 已有范围暂停及岗位间修复；[agent-station.ts](../server/agent-station.ts):152 有有限程序反馈修复；但 `StationSpec` 没有通用 typed pending-input / resume-value 契约，`manual` 主要还是终态与原因字符串 | **P1：人工只接真正需要外部输入的节点**。将缺字段、授权、登录、质量修复耗尽分别编码；pending input 带任务、工位、问题 ID、响应 schema 和允许选项，恢复值去重落盘。通过确定性检查的常规产物继续流转；证据不足不能靠模型自报“通过”跳过。沿用已有结构修改边界，不给每次工具失败加确认弹窗 |
| 并行状态合并 | [Graph API：Reducers](https://docs.langchain.com/oss/javascript/langgraph/graph-api#reducers) 明确每个状态字段的更新/合并语义 | **本轮已实现编译保护**：[workflow-packs.ts](../server/workflow-packs.ts) / [compile.ts](../server/spec/compile.ts) 拒绝可并行的同 outputKey 写入，安装/重载/已接受补丁和跨包 flow 均参与检查；顺序覆盖、不同字段和独立子任务仍允许 | 现有 `test/workflow-packs.test.ts` 的 3 项定向回归覆盖该边界。剩余 reducer 能力按业务需要增加，不用最后完成者覆盖来模拟合并，也不把所有同名字段一概禁止 |
| 子图/子任务 | [Subgraphs](https://docs.langchain.com/oss/javascript/langgraph/use-subgraphs) 区分每次调用隔离与跨调用保留状态，并用 checkpoint namespace 表达嵌套边界 | [channels.ts](../server/channels.ts) 有独立 delivery / child token、输入清洗、ack、续批；[shared/project.ts](../shared/project.ts) `tokenWorkKey` 区分父子同 item；项目 Pack 有持久角色/schema/代码版本 | **已有跨线异步任务，不等于通用嵌套子图**。P2 才补父任务等待子任务集合、取消传播、聚合规则、并行调用命名空间。不要为对齐术语改掉可靠的持久信道，也不要直接把父 checkpoint 复制给独立子任务 |
| 时间旅行与可复现性 | [Use time-travel](https://docs.langchain.com/oss/javascript/langgraph/use-time-travel) 的 replay 会重新执行所选检查点之后的节点，fork 会产生新分支；模型及外部请求可能再次发生 | UI 已有只读事件回放；[runtime.ts](../server/runtime.ts) `correct/undoCorrection` 保存纠错快照、撤销未执行纠错；没有任意历史 checkpoint fork 到独立运行的公共 API | **P2：先明确“回看”与“重新执行”**。目前回看不产生新副作用，应继续保持。需要实验分支时给新 run/工作身份、父 checkpoint 和包版本，展示将重跑的节点与外部写影响；不要把拖动时间轴做成重新发布 |
| 原生 Agent / 闭源客户端节点 | [Streaming：任意模型](https://docs.langchain.com/oss/javascript/langgraph/streaming#use-with-any-llm) 允许将任意客户端的进度经 custom 流发出；框架接口不能证明某个厂商 CLI 已实际兼容 | [claude-code.ts](../server/claude-code.ts)、[opencode.ts](../server/opencode.ts)、[codex.ts](../server/codex.ts) 经工位能力范围接入，保存原生 session、工作目录、实际模型及已读证据；Pi 仍为项目默认，通用 launcher 可配置其他后端。原生模型未覆盖时使用客户端自身配置，不能被 Pi 全局选择替换。配置、捕获身份和回执分离，缺失用量保持未知 | **本轮真实 OpenCode 1.18.14 节点通过**：现有 Go 配置、只读工具、结构化 submit、原生 session export 的实际模型及用量；不等于核验账户账单。用户最新限制下，Codex 与 Claude Code 当前改动只用静态官方协议及本地替身验证，未启动真实客户端。历史 Claude Code 2.1.220 验收不能替代当前版本的真实验收。厂商内部 HTTP 并发与 OS 沙箱不由本应用伪称保证；Codex 仅回报 Token 时费用未知。缺少完整 command 身份的旧闭源 session 不自动复用 |

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

界面启动和 SSE 增加显式 `ui-v1` 摘要协议，默认原始接口继续保留完整记录。以同一份 38,237 事件的只读项目副本测试，HTTP 状态正文从 23.66MB 降至 4.76MB，读取由 320–389ms 降至 110–153ms；并发心跳最高实测 118.4ms，仍不能宣称服务线程完全无阻塞。任务身份、分支、计数、退避、纠错、用量和实际执行模型双投影一致。完整步骤、任务和文本证据经现有 inspect 按需读取，详情缓存独立于主状态，最多 24 项 / 16MiB 序列化字节；取消、旧响应、回放隔离和完整正文展开均有既有回归。后端 Factory/Runtime 的恢复数据未删减，服务端冷热分层仍待继续处理。

入场竞争也有真实 Factory 回归：原先低并发托管的 6 个空位全部被目录领取，已排队来源始终为 0；改为来源与目录按持久入场记录轮换，普通运行的来源与信道同样轮换。跨重启保留顺序，仍服从筛选、目标、入场窗口和暂停，35 项已有回归通过。

普通运行原先没有模型恢复期限，即使服务已恢复，来源仍会被全局暂停永久挡住。本轮新增 [recovery.ts](../server/recovery.ts)，复用原 Journal/Runtime 检查点处理手动、来源和信道任务；网络和可恢复工具故障最多两次，模型连接故障按 30/60/120 秒退避，持续失败后每 15 分钟只验证一个真实工位。等待期限、预算和原工位均持久化；重启保留同一在途试探，不从入口重做已完成步骤。失败入口本身没有前驱时，重启也会恢复其原队列。认领前验证缺失或损坏的检查点，不能把普通恢复条件错误误记成存储故障。现有 model-circuit/recovery/channels 回归覆盖 43 个场景；root 另在既有检查点回归验证原入口输入、来源和证据保留。

托管与普通运行都要求原模型工位的可核验响应才能解除当前轮连接暂停，程序返回成功不能作为模型恢复证据；认证、TLS、未知外部写入、用户暂停和停止继续保留原边界。恢复试探只限制模型任务，独立 CPU/HTTP 工位继续运行，工位内部的模型调用仍受准入检查；原生客户端与 launcher 在打开工具范围和实际启动子进程前也执行相同检查。界面摘要增加有限的恢复字段，区分冷却、等待条件、实际验证、预算耗尽和阻塞原因；结束、旧轮次、已接续重试与成功终态不会伪装成执行中。以上是本地故障与浏览器验收，不是原项目已新增发布的证明。声明式策略的后续落地见下文；长期运行公平性边界和非 Windows 实机验收仍待完成。

进一步修复两类已复现的空闲卡住：无在途执行、队列前沿全部局部暂停的任务，只对与其暂停前沿不相交的目标释放入场名额；同一暂停瓶颈、普通资源等待和无队列证据的未完成任务仍占位。来源与信道继续轮换，既有实际 Factory 回归验证没有增加默认执行名额。用户主动重试耗尽任务时，可重新验证原工位并重置这次明确请求的工具预算，模型故障次数保留；来源停用不被悄悄重新开启。结束旧轮次留下的恢复记录从完整检查点重建全部未完成分支，而不是回到入口重做付费上游；找不到真实待办则拒绝恢复，不重复发布。相关现有回归分别以 34 项恢复组合和 28 项调度组合验证。

模型依赖身份与独立熔断现已落盘：Pi 使用实际解析后的 provider 与端点摘要，原生执行器使用 adapter、启动命令与请求选择摘要，不公开端点认证、命令参数或凭据。每次处理在开始回执前捕获可执行函数、绑定与模型配置，下一次改绑不改变已开始任务；实际 Factory 的 Pi HTTP 和闭源启动器 fixture 均验证首件仍使用 A、下一件使用 B。原始状态、UI 摘要与重放保存同一身份；实际回报的模型名称继续独立记录。确定性跳过模型的规则仍可在模型配置无效时执行。

[model-circuits.ts](../server/model-circuits.ts) 将单依赖的 open/trial/blocked 状态接入 Broker、体检、来源、托管及普通恢复；工具内模型 B 的失败不会用主模型 A 的成功回执解锁。同依赖只允许一个持久化的真实工位试探，重启保留其身份；实际成功解除同依赖旧等待，不能误放其他依赖或用户暂停。旧轮次明确结束、没有在途试探且同依赖实际认证探测成功时，允许新轮次解除遗留阻塞；静态检查不够。当前核心已有文件组合通过 63 项模型、预检、Pi、分配与检查点回归，含实际本地 HTTP 的跨依赖等待和工具证据复用。独立复现还修复了额度提升不唤醒队列、早期网络恢复挡住后续模型试探、持续健康请求使另一依赖永远无法加入 FIFO 的三处空等。

流动分成三层：`model` 管实际请求，`modelWorkers` 管 model 资源类工位在途，`BatchGoal.admission` 管进入流水线的货。缺少工位额度的旧设置用 `max(3, model)` 补全，显式限制仍保留；新目标默认按节拍调整、上限 6/2，已有手动窗口保持不变且可在暂停中配置。入口第一个可执行工序完成就释放入口名额；慢工位仍由已有的样本、排队、资源和防抖机制自动增员。本地真实流水线对照中，第二件从等待首件发布后的 174ms 入场，变为首件仍在处理时的 15ms，6 件样本从约 1.03s 到 0.73s；这不是生产吞吐承诺。实际 Pi SDK 工具等待约 510ms 时，下一工位 10ms 内即可请求，HTTP 峰值始终为 1；此前约 554ms 才开始。原生 CLI 按整次调用占请求名额，满额时嵌套工具模型请求明确报错，不能死锁或绕过配额。

回执同时保存真实 Token、实际模型响应汇总及费用是否完整；[usage.ts](../shared/usage.ts) 统一报告、投影和界面口径。Codex 仅 Token 回执不得伪造零费用；有价格和无价格的混合调用显示已知部分。OpenCode 完整节点实测得到原生 Go 模型、3 次模型调用、只读与 submit 各 1 次，释放全部容量；认证只读取现有客户端配置，不输出内容。该样本验证服务路径，不验证订阅余额或实际扣款。

原项目只读副本还复现了两类错误转人工：文案来源的 `19,000+` 被旧校验去逗号、截前四位后误拒；Pi 返回明确 `server_error` 却被归为普通工具故障。前者改为完整数字及限定符匹配，仅归一化合法千分位与全角字符，不能让 1900 与 19000 冒充；后者仅在模型边界归为可退避的服务故障，认证、余额、TLS 和普通工具错误保留原分类。相关既有回归分别通过 10 项和 5 项，原副本无数据改写。另有 7 件旧组装问题导致的人工项，其素材与检查点已只读核对；代码修复不代表这些任务已重新审核或发布，恢复必须仍经终审与发布门禁。

通用包的网络恢复还修复了一个实际归属空洞：同轮存在网站托管目标时，普通恢复原先跳过整轮任务，而网站恢复又排除工作流包及信道子任务，导致两边都不处理。现在计数、恢复和界面共用 `isBatchToken`，仅网站根任务受网站托管模式约束；独立包及信道仍服从全局/局部暂停、来源启用和既有恢复预算。真实安装的 Node 执行器在手工、信道、来源入口及网站托管运行/停止/暂停的九种组合中，从失败工位继续，上游不重做；认证、明确未知外部操作、取消及两次耗尽保持原边界。没有依赖身份的历史模型故障继续保守共用旧全局熔断。本项修复恢复归属，不是新增可声明重试策略，也不保证任意可信模块自行发出的远端写操作恰好一次。

项目模型选择现由 `agent.defaults` 独立持久化。首次打开旧项目只导入一次 Pi 的 provider/model 文本；之后外部 Pi 窗口修改默认选择，不再改变这个项目。设置页可分别保存工位默认与主调度，节点的显式覆盖继续优先，Pi 的局部覆盖从项目默认补全。切换只影响下一次执行，已开始尝试及恢复中的主调度对话保留原模型。读取接口 `agent_defaults` 与用户写入接口 `set_agent_defaults` 有明确权限，空更新、无效值和不支持的主调度适配器在落盘前拒绝。默认使用 Pi，不再由隐式全局 CLI 环境设置替换整个项目。

隔离回归使用两个实际 Factory、同站多个 worker 和另一工位，通过本地 HTTP 服务记录四个不同会话、并发请求与项目标记；工具写入分别落在各自 Journal，重启后仍保留各自选择。Docs、Toolbox、网络缓存与运行报告改为所属项目路径；主调度会话也使用项目与对话身份。另在现有 HTTP/浏览器回归验证独立保存、节点继承、拒绝后状态不变和重启。这里证明实际隔离契约，不能据此反推旧系统所有节点原本都是一个 Agent。当前主调度支持 Pi；其他原生客户端的节点适配以各自协议验收为准。

图片编解码已从服务线程同步调用迁到共享异步子进程池，覆盖网站处理、截图拼接/检查/补边、组件、PPT、科研绘图、图像效果、风格像素统计、Pi/闭源工位与主调度图片输入。真实入口的同素材对照中：3 张图的网站处理期间，HTTP 最长延迟由约 1.52–1.60 秒降至 12–24 毫秒；10 页 PPT 由约 3.51–3.72 秒降至 21–27 毫秒。WebP 输出和感知哈希逐字一致。这是隔离测试样本，未推断 500 页结果或任意机器的延迟保证。

异步池固定单进程，排队、运行取消、超时、输出上限和名额恢复都在既有 environment 回归中验证；工位/主调度复用既有 35 项会话回归，覆盖准备图片时取消、恢复原会话、迟到的 steer 图片只投递一次。风格检查按 attempt 预计算像素统计，缺证据或校验库必须失败，不能用空校验结果放行。真实发布仍需完整业务门禁；这些测量不能记作用户项目的新增产出。

首轮完成 [channels.ts](../server/channels.ts) 的数据驻留修复：只在构造回放期间临时合并 token.data，回放结束释放；实时在 `channel.emitted` 的投影时刻读取 Factory 状态并复制所需消息，不再长期保存每个 token 的第二份完整数据，也不再每次 token.data 对整个记录做 spread。消息快照、重放去重、检查点重试和低并发行为保持原契约。

随后确认 [lessons.ts](../server/lessons.ts) 的日常工位上下文也在永久缓存完整 Journal。改为只保留经验事件和对应投影版本，普通业务事件不再重建经验列表；工位检查是否属于验证批次也复用同一索引。复盘与证据验证仍按需读取完整历史，审批权限和完整日志不变。在同一 38,237 事件副本（仅 15 条经验事件）中，对比旧提交模块与实际修复实现，GC 后该模块额外常驻堆从 70.48MiB 降至 0.188MiB，200 条普通事件后的增量上下文读取从 305.55ms 降至 43.00ms，各阶段输出 SHA 一致；经验完整回归 14 项通过。这里测的是模块新增常驻堆，未消除复盘、验证的冷操作临时峰值，也不是总 RSS 降幅。

- `node --test --test-concurrency=1 test/channels.test.ts`：10/10 通过，约 7.3 秒；覆盖同批快照、三类崩溃窗口、旧库存、暂停、跨重启复用结果和证据、父子身份、有限组件续批。
- `npx tsc -p tsconfig.json --noEmit`：通过。
- 本轮没有新增测试文件；没有测量具体 RSS 降幅，不将运行时长差异当内存或性能收益证据。

随后外部副作用回执在同一 `test/workflow-packs.test.ts` 中完成本地 HTTP/CLI/MCP 与真实 Factory 验收。先复现响应丢失、重启重投导致外部写入两次，再验证：提交 intent 前禁止 I/O；completed 跨重启复用；started/uncertain 不重发；失败落盘仍保留 intent；多次 retry 与信道子任务身份稳定；输入或版本变化分别判定；GET/已声明只读 MCP 保持读取；本地配置失败不制造 unknown；取消重复等待者不取消原执行者；Runtime 将未知结果保留 manual 并取消旁支，重启和显式纠错不重发。回执阶段沿用 Dispatcher 的 `uncertain` 词汇，对用户显示“结果未知”。

声明式恢复现通过 `StationSpec.recovery` 与 `WorkflowBinding.recovery` 接入同一监督器。尝试开始时捕获策略，自动恢复沿用已保存预算和抽取后的等待时间；恢复过程的总期限包含暂停、排队及重启。模型收到响应后仍可能是工具失败，不能因此清零任务预算；浏览器内部恢复也不能绕过显式零次策略。期限后的迟到结果只保留会话、用量和更严格的副作用状态，不继续发布。耗尽转人工先保存终态回执，再原子提交处置和库存；用户通过明确条目恢复原检查点，自动候选不重复领取，缺检查点则拒绝回入口重做。

界面分别显示工位当前声明和任务保存的策略，紧凑状态与 SSE 保留实际次数及绝对期限。候选页的“恢复待人工”仅表示技术恢复耗尽，不冒充全部内容质量待审；离线、回放和重复点击均受保护。此能力没有自动改变原项目的工位策略，也不能证明真实业务全部通过。专门回归复用已有 recovery、browser-recovery、workflow-packs、runtime-storage-fault、manual-stock、control 与 inspector 文件，没有新增测试文件。

| 后续改动 | 复用已有回归 | 必须证明的结果 |
|---|---|---|
| SSE / 历史读取 / 内存 | `test/report-responsive.test.ts`、`test/journal-atomic.test.ts`、`test/ui-report-activity.test.ts` | 慢读/断开后后台仍响应；游标不丢不重；读取范围固定；取消释放缓存和等待者 |
| 外部副作用回执 | `test/workflow-packs.test.ts`、`test/runtime-storage-fault.test.ts` | 模拟外部已执行但本地未提交，重启先查结果，不重复调用 |
| 并行写冲突 | `test/workflow-packs.test.ts` | 并行同键拒绝；顺序覆盖/独立字段仍可运行；不受完成顺序影响 |
| 少打扰与恢复策略 | `test/station-safety.test.ts`、`test/runtime-retry-checkpoint.test.ts`、`test/runtime-restart.test.ts` | 程序可确认的修复自动继续；认证/未知副作用保留明确问题；取消不重试，修复预算跨重启保留 |
| 闭源节点选择与恢复 | `test/agent-adapter.test.ts`、`test/mcp-security.test.ts` | 同图可选不同 adapter；重启恢复正确会话；作用域与取消保留；实际模型/用量缺报保持未知 |

文档中的 P0/P1/P2 是缺陷影响和依赖关系的排序，不是另建开发流程。历史卡顿修复及持续低并发产出优先；资料不支持的能力不列为已交付。
