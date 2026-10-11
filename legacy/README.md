# 早期工作流原型

这里保留 Easy Workflow 早期的确定性流程原型，用于检查阶段调度、结构化交接、事件顺序和失败恢复。它与当前桌面应用分开运行，不调用外部模型，也不作为生产验收数据。

## 目录

- `workflow_spec.py`：声明阶段、角色职责和固定的交接拓扑。
- `workflow_demo.py`：按阶段执行；设计阶段的独立角色通过 `ThreadPoolExecutor` 并行，全部结束后再交给下一阶段。
- `test_workflow.py`：验证成功结果、稳定拓扑、连续事件序号，以及失败后的结果保留和下游阻断。
- `index.html`：读取运行记录，显示阶段、角色状态与结构化结果；也可回放内置演示数据。

流程包含需求、设计、实现检查、测试验证和维护记录五个阶段。所有角色返回结构化结果；协调者汇总结果，检查程序核对事件序号、角色终态与图拓扑。失败时保留已完成产物，后续阶段保持 `pending` 并记录 `blocked_by`。

## 运行

以下命令在 `legacy/` 目录内执行：

```powershell
python workflow_demo.py --delay 0
python workflow_demo.py --fail 证据审查员 --delay 0
python -m unittest -v
```

默认输出到当前目录的 `run.json`；可通过 `--output` 指定其他位置。成功返回退出码 `0`，注入失败返回 `1`。生成的记录只用于本地检查，不随产品发布。

## 查看结果

```powershell
python workflow_demo.py --delay 0
python -m http.server 8802
```

打开 `http://127.0.0.1:8802/index.html`。页面优先读取同目录 `run.json` 并按事件顺序回放；直接打开 HTML 无法读取该文件时，使用内置协议样本。点击阶段可展开角色，“开始运行”用于重播，底部输入区仅记录后续修改意图。

这个原型只验证调度与数据协议。当前可运行能力、模型接入和项目数据约定以仓库根目录的 [README](../README.md) 与 [Spec](../Spec.md) 为准。
