# H2 · Software Engineering Agent Workflow

H2 把 ZCode 的多 agent 运行模型放进软件工程流程：需求、设计、构建、测试、维护。它不是把三个聊天窗口并排摆出来，而是用一个声明式阶段图约束谁先做、哪些任务可以并行、结果怎样交接，以及失败后停在哪里。

## 后端做什么

- `workflow_spec.py` 声明阶段、软件工程知识域、具名 actor 和稳定的 handoff 拓扑。
- `workflow_demo.py` 执行阶段，阶段内独立 actor 用 `ThreadPoolExecutor` 并行，阶段之间由协调者汇总后再放行。
- 每个 actor 必须返回结构化结果；协调者只读取结果，不从自然语言猜测隐含状态。
- `Run.events` 是追加式运行日志，包含序号、相对时间、阶段、actor、状态和产物。
- `graph` 是静态拓扑叠加运行状态，节点和边在运行中保持稳定，适合后续 ZCode 风格 Web UI 实时消费。
- 哨兵检查事件序号、actor 终态和图拓扑；失败时保留已经完成的产物，并把后续阶段留在 `pending`，记录 `blocked_by`。

## 软件工程流程映射

| H2 阶段 | 软件工程知识域 | 主要 actor |
| --- | --- | --- |
| 需求与范围 | Software Requirements | 需求协调者 |
| 设计与依赖审查 | Software Design | 架构审查员、证据审查员、测试规划员 |
| 实现与变更检查 | Software Construction | 实现检验员 |
| 测试与质量验证 | Software Testing | 测试验证员 |
| 维护与交付反馈 | Software Maintenance | 维护记录员 |

设计阶段的三个 actor 是独立读任务，会并行 fan-out；只有它们全部结算后，构建阶段才会开始。这就是 H2 相比“多次调用同一个 prompt”的新增内容：调度、门禁、结构化交接和可复盘证据都由运行时负责。

## 运行

```powershell
python workflow_demo.py --delay 0
python workflow_demo.py --fail 证据审查员 --delay 0
python -m unittest -v
```

默认写入 `run.json`。也可以指定路径：

```powershell
python workflow_demo.py --output artifacts/run.json
```

失败注入会返回退出码 `1`，但已完成的 actor 结果仍会保留；后续阶段不会假装执行。成功运行返回退出码 `0`。

## 与 H1 的关系

H1 是单 agent 的代码证据层：文件、符号、调用、导入、源码和测试结果。H2 是多 agent 的执行层：阶段、角色、并行、汇总、失败和维护反馈。下一步接入时，H2 actor 可以把 H1 的图谱查询、源码读取和测试执行注册成工具；workflow graph 负责展示过程，code graph 负责提供证据。

## 与 ZCode 的对应

| H2 | ZCode |
| --- | --- |
| `PhaseSpec` | `phase("...")` |
| `ActorSpec` / `ask()` | `agent(name).ask(...)` |
| `ThreadPoolExecutor` | 阶段内 Promise fan-out |
| `coordinator` 事件 | join / collect 门禁 |
| `Run.events` | log / report journal |
| `project_graph()` | 静态图 + live status overlay |
| `audit()` | settlement / sentinel 检查 |

当前版本故意使用本地确定性 actor，先把协议、状态和证据边界做实；后续只需替换 `ask()` 内部的模型驱动器，不需要重写调度器或前端数据协议。
