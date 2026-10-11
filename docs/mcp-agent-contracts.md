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

工位入口与控制面分开。`runAgentStation` 在配置了 `FACTORY_STATION_COMMAND` 时使用外部 launcher，未配置时继续使用 Pi。该变量必须是 JSON argv 数组，例如一个 Node 可执行文件和一个本地 launcher 文件；不拼 shell 命令。`FACTORY_STATION_MODEL` 指定请求的模型，launcher 的回复必须写实际使用的模型。

launcher 在 `<项目>/work/<token>/` 中运行，标准输入接收 JSON。使用平台实际传入的协议版本和临时 MCP 配置，不硬编码旧客户端的字段取值：

| 字段 | 含义 |
|---|---|
| `protocol` | 当前 launcher 契约版本；按服务提供的版本校验 |
| `model` | 请求使用的模型 |
| `firstMessage` | 包含角色、上下文、案卷、本次契约和输入的第一条用户消息 |
| `messages` | 本次完整对话历史，重答时包含此前提交与检查反馈 |
| `mcpServers` | 平台生成的本次工位 MCP 配置，包含启动命令和私有连接信息；按传入值使用 |

以上仅说明字段结构；实际 `messages` 包含完整 `firstMessage`，重答时继续包含先前提交与程序检查反馈。图片以标准 image 内容块加入第一条输入。**launcher 必须把 `firstMessage` 作为该厂商会话的第一条用户消息，并把后续 `messages` 顺序原样映射到同一对话历史。** 厂商 CLI/API 的调用方式由 launcher 负责；Easy Workflow 没有猜测 Claude、Codex 等工具的命令行参数，也没有完成这些厂商的实际模型兼容性验证。

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
