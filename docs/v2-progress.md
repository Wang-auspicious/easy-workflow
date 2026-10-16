# Easy Workflow v2 执行记录

## 2026-10-15 · A.2 启动遍历盘点（仅文档）

执行依据：`docs/spec-v2-kernel.md`。阶段顺序 A → B → C → D → E → F；本次尚未修改实现或进入后续阶段。

工作现场已有未提交修改，已保留为本地基线 `a10415c`，v2 在隔离分支 `codex/v2-kernel` 实施。原工作目录、真实运行项目及 VisLexicon 仓库不改动。以下行号是该基线的行号。

盘点命令：

```powershell
rg -n 'read\(0' server shared
rg -n 'journal\.(read|readKinds|runs)|\.history\(' server
```

逐一阅读 `Factory.boot/restore`、`Docs`、`Lessons`、`ChannelSupervisor`、`SourceSupervisor`、`PublicationOutbox`、`Dispatcher` 的构造及启动调用链。

| 文件、函数 | 历史读取及事件 kind | 产出的内存结构／用途 |
|---|---|---|
| `server/factory.ts:114` · `Factory.boot` | `journal.read(0)`，全部事件 | `apply` 生成完整 `FactoryState`；同循环喂给 `Docs.observeReplay` |
| `server/factory.ts:118` · `Factory.boot` completedRuns | 上述同一循环中的 `run.ended` | `Set<string>`，启动时为已结束轮次修复经验草案 |
| `server/docs.ts:244` · `Docs.refresh`（旧称 catchup） | `read(indexedSeq)`，全部事件；当前 boot 已共用主重放，首次独立使用仍可能从 0 开始 | `indexedSeq`、`caseSequences`、`tokenCases`、`attemptTokens`、`runs`、`currentRun`、`runSeq`；仅索引序号，不保留全量业务正文 |
| `server/lessons.ts:156` · `Lessons.lessonEvents` | `readKinds` 默认起点 0：proposed/revised/validated/approved/rejected/applied/validation.started/validation.bound/validation.exposed 等 `lesson.*` | `cachedLessonEvents`、`indexedSeq`、`lessonSeq` 以及派生 `cachedViews` |
| `server/lessons.ts:170,206` · `Lessons.history/draftRun` | 每个已结束 run 读取从 0 到该 run 最后 seq 的全部事件，再由 `groupLessonObservations` 重放 | 历史投影、按节点／失败／框架分组的观察；生成幂等草案。不是仅恢复 lesson 索引就能消除的扫描 |
| `server/channels.ts:29` · `ChannelSupervisor.constructor` | `readKinds` 默认起点 0：`token.data/channel.emitted/channel.delivery` | `deliveries`、临时 replayData、每个 emission 当时的 payload、`tokensByDelivery`、`deliveryByToken`；重放后修复未消费 emission 和 delivery 回执 |
| `server/sources.ts:64` · `SourceSupervisor.constructor` | `readKinds` 默认起点 0：`source.configured/polled/requested/candidate/reputation` | `definitions`、`polls`、`requests`、`candidates`、`authors`；随后按已恢复 token 补候选完成回执 |
| `server/publication-outbox.ts:170` · `PublicationOutbox.restore` | `readKinds` 默认起点 0：`token.created/data/finished` | token 元数据、pending、blocked、knownDigests、cursor、batches；同时读取已有 outbox 文件与 manifest 并校验证据。首次安装不把历史发布重标为新工作 |
| `server/factory.ts:1164` · `Factory.restore`（额外发现） | `readKinds` 默认起点 0：`token.queued/finished/data/returned`、`attempt.finished` | done、notes、checkpointed、当前 run 的 arrivals/sampleItems，然后恢复 v1 token、队列和调度状态 |
| `server/dispatcher.ts:69` · `Dispatcher.constructor`（额外发现） | `journal.read()` 默认起点 0，过滤 `chat.checkpoint` | 最后一个 `DispatcherCheckpoint`；由 `server/main.ts` 在 boot 后、listen/ready 前创建，属于 ready 阻塞路径 |

`rg 'read(0'` 命中 3 处（factory、lessons、report），不足以覆盖默认参数和按 kind 读取。额外辨明以下按需路径：`Dispatcher.orderedHistory` 在恢复聊天／首次构造 Agent 时读取历史；`OperationLedger.refresh` 在首次外部操作时从 0 建索引；`Runtime` 的纠错／撤销、capture supplement、报告导出、案卷正文读取和 API 分页由对应操作触发，不是普通 paused 桌面 ready 的启动扫描。恢复中的实际调用仍需计时验证。

保真边界：

- `Journal.read(since)` 是严格 `seq > since`；规范 A.6 的 inclusive `from = snapshot.seq + 1` 必须转换为 `read(minFrom - 1)`。
- 六组件可能恢复不同 seq 的快照。历史 emission 必须使用信道自身在该 seq 的数据，不能读取已恢复到未来 seq 的 FactoryState。
- v1 恢复的 checkpoint／退回顺序、经验的历史上下文、发布队列外部文件对账必须保持原语义。
- 桌面当前基线已是固定 180000 ms 超时；A.8 仍应实现收到 `BOOT_STAGE` 延长 30 秒、总上限 180 秒、无输出 30 秒超时。

真实项目仅作只读定位与 SQL 计数：当前为 **187490 个事件**，大于规格起草时约 13.6 万。已开始完整目录复制到 `%TEMP%/ew-v2-copy-20261015`，后续运行使用副本。正式计时前还会确认副本一致性和事件数。

阶段 A 验收尚未执行；没有以盘点结果代替性能或行为验收。
