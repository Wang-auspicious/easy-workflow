# MCP 与工位 Agent 接入

控制面使用真正的 MCP stdio：客户端启动 `node server/mcp.ts`，先发送 `initialize`，再发送 `notifications/initialized`，之后用 `tools/list` 和 `tools/call`。协议版本为 `2025-06-18`；标准输出只有按行编码的 JSON-RPC，诊断不写入 stdout。

## 主调度

MCP 配置中的 `command` 指向 Node 24+，`args` 指向 Easy Workflow 仓库中 `server/mcp.ts` 的绝对路径。连接通过现有 Pi 配置目录自动发现，也可以在 MCP 进程环境中设置 `FACTORY_AGENT_CONNECTION` 为实际连接文件路径。不要把文件中的 token 放进配置示例、提示词或仓库。

只注册两个入口：

- `easy_workflow_help({})` 返回当前服务的 bootstrap；`easy_workflow_help({name})` 返回现有注册表的精确 schema。
- `easy_workflow_call({name, arguments})` 调用现有 HTTP 能力并返回真实回执，保留 schema 校验、只读限制、seq 与 runId。MCP 主调度不能执行 `decide_patch`；批准由站长完成。

这个桥接器只连接本机 HTTP 服务，不跟随重定向。它不启动工厂、不复制业务实现、不自动重试写请求。取消或超时后先查实际状态，再决定是否重试。

`easy_workflow_help` 返回的 `roleAuthoring` 说明新增工位的手写 ROLE 结构、可按需读取的已有岗位和批准要求。新增执行节点还必须有 executor 与测试。

## 闭源工位 Agent

工位入口与控制面分开。用户可在节点检查器的“规格 → 工位 Agent”中，为实际 Agent 工位选择继承默认、Pi、Claude Code 或自定义 launcher。程序工位不显示 Agent 配置；其执行方式仍是程序。界面同时显示生效来源、请求模型、最近回报模型和适配器能力，未回报用量不补成零。

配置优先级是项目中的节点覆盖、工作流包的 `execute.agent`、应用默认。项目覆盖由用户路由 `POST /api/agents/binding` 保存，参数为 `{node, binding}`；`binding:null` 恢复继承。变更写入项目 journal 并在重启后恢复，不修改其他节点和全局环境变量。仅下一次 attempt 使用新配置，已开始的尝试保持原配置；执行适配器、命令或模型变更不会复用旧签名的会话。只读能力 `agent_bindings({node?})` 返回配置、生效值、来源及真实能力；程序节点的查询结果为 `bindings:[]`。

Pi 配置格式为 `{adapter:"pi", provider?:string, model?:string}`，省略字段使用应用默认。外部配置为 `{adapter:"claude-code"|"launcher", command:string[], model:string, requestTimeoutMs?:number}`；启动命令必须是 JSON argv 数组，不能传 shell 命令字符串，超时为 1–900000 毫秒。角色、工具范围、结构化提交、修复与程序校验对所有适配器继续有效。凭据沿各客户端已有认证方式使用，不通过节点配置写入。

工作流包可在真正的 Agent 执行器中声明同样的默认值，例如：

```json
{
  "execute": {
    "kind": "agent",
    "instructions": "按本站职责处理给定输入，并通过 submit 提交符合输出契约的结果。",
    "agent": {"adapter": "claude-code", "command": ["claude"], "model": "haiku"}
  }
}
```

安装时校验适配器字段，非法配置在替换安装清单前被拒绝；省略 `agent` 保持原有默认。程序执行器不能附加此配置。应用默认继续兼容环境变量：配置了 `FACTORY_STATION_COMMAND` 时使用外部 launcher，未配置时使用 Pi。该变量必须是 JSON argv 数组，例如一个 Node 可执行文件和一个本地 launcher 文件；不拼 shell 命令。`FACTORY_STATION_MODEL` 指定请求的模型，launcher 的回复必须写实际使用的模型。

launcher 在 `<项目>/work/<token>/` 中运行，标准输入接收 JSON。使用平台实际传入的协议版本和临时 MCP 配置，不硬编码旧客户端的字段取值：

| 字段 | 含义 |
|---|---|
| `protocol` | 当前 launcher 契约版本；按服务提供的版本校验 |
| `model` | 请求使用的模型 |
| `firstMessage` | 包含角色、上下文、案卷、本次契约和输入的第一条用户消息 |
| `messages` | 本次完整对话历史，重答时包含此前提交与检查反馈 |
| `mcpServers` | 平台生成的本次工位 MCP 配置，包含启动命令和私有连接信息；按传入值使用 |

以上仅说明字段结构；实际 `messages` 包含完整 `firstMessage`，重答时继续包含先前提交与程序检查反馈。图片以标准 image 内容块加入第一条输入。**launcher 必须把 `firstMessage` 作为该厂商会话的第一条用户消息，并把后续 `messages` 顺序原样映射到同一对话历史。** 未指定 `FACTORY_STATION_ADAPTER` 时使用这份通用 launcher 契约；原有接入方式保持兼容。Claude Code 的显式适配见下节；其他厂商仍由其 launcher 翻译官方协议。

`mcpServers` 中的工位连接仅服务于本次回答。它使用单独随机凭据，只公开：

- `env_help`：本工位允许工具的说明及参数。
- `env_call`：固定绑定本工位、token、案卷与允许清单；客户端不能更换这些身份。
- `submit`：该工位原有输出 schema；每次回答只能提交一次。Easy Workflow 原有程序检查、一次修复及 salvage 流程继续生效。

没有 `easy_workflow_help`、`easy_workflow_call`、全局调度或规格批准能力。工位进程不会收到 `FACTORY_*` 环境变量、全局 Pi 连接目录或控制面 token，过滤同时处理 Windows 环境变量大小写。只要进程带有工位连接信息，即使漏传 `--station` 也保持受限模式。每次回答结束、取消或超时都会撤销连接、取消未完成的工位工具、关闭监听并删除临时凭据。取消时只终止本次启动的 launcher 及其子进程树。使用同一 OS 用户的 launcher 仍是受信任的本地程序；这不是文件系统沙箱。

launcher 完成后 stdout 返回一份 JSON，不输出额外日志：

```json
{
  "model": "actual-model-id",
  "usage": { "input": 100, "output": 20, "cost": 0.001, "cacheRead": 30, "cacheWrite": 5 },
  "time": { "firstTokenMs": 80, "outputMs": 200, "modelCalls": 1 }
}
```

`usage` 和 `time` 可省略；省略表示客户端没有报告，不能补造估计值冒充实测。`input` 指不含缓存读写的输入量，缓存单独报告；缺报缓存量保持未知。stderr 不转发到 Easy Workflow 日志，以免厂商输出混入提示词或凭据。MCP 成功响应与错误都会检查并移除连接凭据；含凭据的提交参数被拒绝，launcher 回报的模型名也不能夹带凭据。实际结果只能经 MCP `submit` 交回，stdout 不能绕过 schema 提交业务结果。

失败时可以返回 `error: {type: "transport" | "credentials" | "quota" | "tls" | "contract"}`，并以非零退出码结束。平台按结构化类别处理，不把厂商原始诊断或 stderr 写入日志。若失败前已经回报模型与用量，保留这部分消耗；未回报模型的启动/鉴权失败不能伪造模型名称。可单独回报 `modelCalls`，无需为此伪造首字和输出耗时。`FACTORY_STATION_TIMEOUT_MS` 限制一次 launcher 回答的整个生命周期，默认 180000 毫秒，可配置 1–900000；到期终止本次进程树并撤销 MCP。

### Claude Code 适配

显式配置 `FACTORY_STATION_ADAPTER=claude-code`，`FACTORY_STATION_COMMAND` 是本机 Claude Code 可执行文件的 JSON argv 数组，例如 `["claude"]`；`FACTORY_STATION_MODEL` 是请求的模型或厂商支持的别名。它使用 Claude Code 自己已有的认证方式，平台不读取或迁移其认证文件。

适配器采用官方 `--print`、`stream-json` 输入输出及 `--resume`，把首条用户消息、图片和本次 MCP 连接转换成厂商协议。它禁用原生工具、技能、用户/项目设置和 hooks，仅加载本次 `h2_station` MCP；权限模式为 `dontAsk`，不使用跳过权限检查选项。启动时最多等待 10 秒让本地 MCP 就绪；初始化回执若缺少 `submit`、出现其他工具或 MCP 服务，任务立即失败。一次回答最多 12 轮；外层工位的工具调用预算、超时和结构化提交检查仍生效。

平台自己的会话检查点保存在当前项目，绑定工位、角色内容与版本、项目约束、工具范围、验证试验、请求模型、输出 schema、输入和返工原因的签名。滚动案卷与运行记录不参与签名；恢复时仍发送当前工位消息。重启或从失败工位重试时恢复厂商 session ID、已读证据和累计工具调用预算；签名改变时不复用。停止或结束本轮只持久化这些主机生成的会话元数据，丢弃被取消的业务输出；纠错换代后的旧会话元数据同样丢弃。任务成功后清除当前 token 的工位检查点，不删除厂商自己的会话历史。

会话引用保存主机生成的原工作目录，采用项目相对路径。调用方显式提供项目根与 work 根；恢复前验证目录存在、位于本项目 work 内，并拒绝绝对路径、向上跳转、符号链接和 Windows junction。新的 token 在原受控目录恢复厂商会话，同时获得新的 MCP 作用域和当前工位消息。平台不读取厂商 transcript。Claude Code 2.1.220 的真实验收表明，在新 token 目录直接恢复 UUID 会报找不到会话，因此运行时保留原目录，不依赖新版文档描述的跨目录自动搜索。

实际模型取自结构化回执。每次回答都启动一个新的 CLI 进程，完整采用该进程的 `usage` 与 `total_cost_usd`，恢复会话也按本进程回执计量；会话引用不参与费用计算。此口径已用本机 CLI 的真实恢复回执核对，不套用长期运行的 Agent SDK 会话累计计数。费用是厂商客户端报告的**估计费用**，不是账单核验值。多个内容块共用同一 assistant message ID 时只计一次模型调用；没有位置与时间证据时，首字和输出耗时继续标为未知。

协议依据：[非交互调用](https://code.claude.com/docs/en/headless)、[会话恢复](https://code.claude.com/docs/en/sessions)、[费用和用量](https://code.claude.com/docs/en/agent-sdk/cost-tracking)、[MCP 启动等待](https://code.claude.com/docs/en/agent-sdk/mcp)。Claude Code 2.1.220 已通过隔离的真实 `runAgentStation` 验收：仅 `submit` 可用，`2 + 2` 经 MCP 提交 4，schema 与程序检查通过；实际模型 `claude-haiku-4-5-20251001`，无权限拒绝，8.58 秒，客户端估算费用 0.003904 美元。此前一次裸适配器调用未提交；其诊断记录不足以确认原因，不能当作成功。

真实恢复验收先提交后受控返回未完成，再以新的 token 继续同一厂商 UUID：原目录保留、MCP 作用域更换、提交绑定新 token、成功清除其平台会话引用均通过。两进程的客户端回执分别为 0.004815 和 0.005315 美元，合计 0.01013 美元。验收同时发现旧差分算法将第二次费用少记成 0.0005 美元；已修为每个新进程独立计量，并把上述净化回执加入确定性回归。失败的跨目录尝试和费用错误记录均保留，没有为修正计费再次付费调用。每次最多 90 秒，每组两次调用总预算 0.10 美元，未改变生产默认。厂商测试会话经该版本官方 `claude project purge` 按隔离目录清理；本地临时目录按要求保留。其他版本与完整业务线仍需各自验收，取消等异常使用明确标识的协议 fixture 回归。

## 报告

`read_report({runId})` 按指定轮次的 journal 汇总；省略 runId 才读当前轮次。旧版 report.json 缺少 metrics 时，在原轮次日志存在的情况下重新计算返回，不覆盖历史文件。

`metrics.tokens.estimated` 是字符数与图片预算产生的初始输入估算，加上累积工具结果；它不是每次模型重复上下文的计费分摊。`estimatedFields` 和 `estimateBasis` 明确标记这一点；`actual` 只来自日志里记录的客户端用量。`coverage` 给出哪些 attempt 真正有测量，以及哪些 attempt 的模型回应完整报告了用量和缓存。部分已知量仍保留为小计，缺报时不生成缓存命中率或输出速度。未知数据为 `null`，已报告的零才是 0。重复的同一 attempt 结束回执只采用最后一条，不重复计费。

耗时是多个 attempt 的累计工作时间，可能因并行而超过整轮墙钟时间；`time.aggregation` 明确为 `sum-of-attempts`。排队、模型首字、输出、工具、程序、其他时间分别汇总。输出速度只用同时具备实际输出量和模型输出耗时的样本。自动重试保留第一次失败调用的已记录用量和耗时。每个工位和每次 attempt 仍保留各自 metrics，可逐项追溯。

## 验证依据

- `test/mcp.test.ts`：协议生命周期、取消、真实 stdio 子进程、现有注册表与认证、工位边界、撤销。
- `test/agent-adapter.test.ts` 与 `test/fixtures/closed-agent-launcher.mjs`：实际 launcher 子进程读取第一条消息，经真实 MCP 提交、拒绝越权与重复提交、程序检查后第二轮修复、实际用量回传。
- `test/report-metrics.test.ts`：历史隔离、估算与实际分开、缓存、耗时、缺失数据。
- `test/mcp-security.test.ts`：Windows 环境大小写过滤、凭据脱敏、丢失参数仍受限、调用取消、真实进程树终止和作用域撤销。

协议按 MCP 官方 [stdio 传输](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)、[生命周期](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) 和 [tools](https://modelcontextprotocol.io/specification/2025-06-18/server/tools) 实现。
