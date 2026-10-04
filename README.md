# H2 · Agent Team

H2 研究 ZCode 的动态工作流：阶段、并行 worker、协调汇总和运行日志。

这个 Demo 不复制 ZCode 的完整运行时，只保留四个能看懂的动作：

1. 进入一个阶段，明确这一阶段要完成什么。
2. 在同一阶段并行运行三个 worker。
3. 协调者收集结果，判断是否可以进入下一阶段。
4. 哨兵检查运行日志，留下可复盘的结果。

运行：

```powershell
python workflow_demo.py
```

浏览器展示：直接打开 `index.html`，点击 `Run demo`。

## H2 需求

- 支持一个协调者和至少两个不同角色的 worker。
- 阶段有明确名称、顺序和状态：pending、running、done、failed。
- 同一阶段的独立任务可以并行；下一阶段必须等前一阶段收齐结果。
- 每个 worker 返回结构化结果，协调者只读取结果，不猜测隐含状态。
- 保存事件日志，能看到谁在什么时候做了什么、结果是什么。
- 失败时保留已完成结果，并明确停在哪个阶段。
- 页面展示阶段轨道、worker 卡片、运行状态和日志尾部。

## 与 ZCode 的对应

| 这个 Demo | ZCode 概念 |
| --- | --- |
| `phase()` | 阶段标记 |
| `worker()` | `agent(name).ask(...)` |
| `ThreadPoolExecutor` | 阶段内并行 fan-out |
| `collect()` | 协调者汇总 |
| `event()` | `log()` / `report()` |
| `sentinel()` | 运行状态与日志审查 |

H2 的重点是协作协议和状态流转。真正的模型接入、工具权限、恢复和持久化会在后续迭代里替换 Demo worker。
