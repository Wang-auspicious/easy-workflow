# H2 · Agent Team

H2 研究 ZCode 的动态工作流：阶段、具名 actor、并行 fan-out、协调汇总和运行日志。

这个 Demo 不复制 ZCode 的完整 TypeScript 引擎，只保留后端协作协议：

1. 协调者进入阶段并写入 `running/done/failed` 状态。
2. 同一阶段的三个具名 actor 并行执行 ask。
3. 协调者只读取结构化结果，决定是否允许下一阶段。
4. 哨兵检查事件序号、终态事件和 worker 结果，形成结算。

运行：

```powershell
python workflow_demo.py
```

注入失败路径，观察已完成结果如何保留：

```powershell
python workflow_demo.py --fail 编辑提交员
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
| `Run.phase()` | `phase("...")` 阶段事件 |
| `ask()` | `agent(name).ask(...)` |
| `ThreadPoolExecutor` | `Promise.all` 式阶段内并行 fan-out |
| `coordinator` | join/collect 后才允许下一阶段 |
| `Run.event()` | `log()` / `report()` 事件日志 |
| `audit()` | 哨兵审查与 run settlement |

`run.json` 保存一次完整结算：阶段状态、worker 结构化结果、事件序号、失败停止点和哨兵报告。真正的模型接入、工具权限、恢复和持久化会在后续迭代里替换 Demo worker；当前后端已经把这些边界固定下来。

## 验证

```powershell
python -m py_compile workflow_demo.py
python workflow_demo.py --delay 0
python workflow_demo.py --fail 编辑提交员 --delay 0
```
