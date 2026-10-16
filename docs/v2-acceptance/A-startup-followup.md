# 阶段 A：需要站长确认的最小追加范围

当前状态：A 未通过，B 尚未开始。原验收要求仍为连续 3 次桌面后端 ready ≤ 5000 ms。

站长已明确确认：**“允许这两项最小优化并继续”**。以下范围已获授权，正在实施；其余约束与验收标准不变。

## 已有证据

最新三次桌面后端 ready：**15350 / 4372 / 4352 ms**。父进程阶段接收日志显示第一轮 import 标记在 166 ms、journal 标记在 7729 ms；之后两轮分别约 1 秒进入 journal。第一轮 factory-state 恢复为 1787 ms，后两轮 1525 / 1555 ms。完整数据保存在 `A-ready.json`。

独立分段测量中，每次启动的 `Docs.writeAllContexts` 约 893 ms，`Lessons.write` 约 215 ms；其中部分是重复生成和重写内容相同的文档。v1 恢复索引仅约 52 ms。

这说明只做快照仍没有满足全部三次要求。早期阶段包含模块加载和构造初始化；现有数据尚不能把 7.6 秒全部归因于 Playwright，所以追加优化后仍必须重新实测，不能预先宣称它会通过。

## 已授权的改动范围

1. `server/browser.ts`：将唯一的 `playwright-core` 值导入改为类型导入。三个现有的异步调用点在真正需要 `launchPersistentContext` 或 `connectOverCDP` 时执行动态 import。原共享 `context/connection` Promise 仍在发起时赋值，保留并发单例、取消和恢复语义。桌面 native 浏览器的 state/open 等原有 RPC 行为不改。没有新增依赖或开关。
2. `server/docs.ts`：`atomicWrite` 仍先验证目标路径；已有文件内容与新渲染内容完全相同时直接返回，有差异或缺失时继续原来的临时文件、fsync、rename。`server/lessons.ts` 已经读取旧文件，只在新旧正文不同时写回；内部经验渲染可直接读取缓存投影，公共 `list()` 继续返回深拷贝。保留 ready 前文档内容正确，不将工作延后来缩短计时。

不改验收阈值、事件/输出 schema、accept、curation.gate、规则文件、UI、v1 执行逻辑或真实项目。

## 验证要求

- 原浏览器崩溃恢复、取消、桌面/独立模式测试通过。
- 派生文档相同内容不重写；变化、缺失、符号链接防护、失败原子替换等原测试继续通过。
- 重新执行完整 npm test、类型检查、构建和桌面冒烟。
- 再次按 snapshot CLI → 桌面 3 次流程测量；仍要求每次 ≤ 5000 ms，保留全部失败记录。

另有独立的 Windows 测试环境问题：最近完整回归 695 项，692 pass / 2 EPERM fail / 1 skip；失败发生在未修改的工作流安装代码临时目录 rename 阶段，整个对应文件随后 28/28 通过。不能据此把完整 npm test 标为通过，仍需完整重跑。
