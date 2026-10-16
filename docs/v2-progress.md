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

## 2026-10-15 · A 实现与验证进行中

已实现六组件快照、共享一次有界尾部重放、损坏／版本不匹配回退、5000 事件／成功写入后 10 分钟／正常退出写入、离线 CLI、30 秒阶段续期与 180 秒启动封顶。v1 恢复索引同在 factory-state 中；Dispatcher 改用最新单条检查点查询。业务图变更会重新建立相应投影后更新快照版本。正常退出最多等待 180 秒完成大项目快照。

未修改 `ui/`、`packs/`、`Spec.md` 或 v2 spec；没有新增 npm 依赖。阶段 B 尚未开始。

副本准备曾因原项目绝对路径阻断：`Invalid intake manifest path`。按 §0.4 写明等待站长决定，并获得明确授权“允许，仅修正验收副本的路径并继续”。实际仅副本元数据 53 文件、journal 1629 行被重定位，保留 **187492 个事件**。原始数据库和元数据均已备份到 TEMP。**4666 份导入附件 + 61 份发布记录**的 SHA-256/bytes 核验通过，内容寻址原件保持原字节；所有后续实验仍指向副本。准备脚本与说明见 `v2-acceptance/A-rebase-copy.mjs` 和 `v2-decisions.md`。

已完成的定向验证（测试组有重叠，不相加为总测试数）：

| 命令 | 结果 |
|---|---|
| `node --test test/journal-atomic.test.ts` | 11/11，通过 20000 事件三个切点、六组件混合切点、坏快照、版本、旧只读库、事务、恢复索引历史顺序及离线副作用验证 |
| `node --test --test-concurrency=1 test/lessons.test.ts test/docs.test.ts test/docs-factory.test.ts` | 23/23，通过，33.48 秒 |
| `node --test test/channels.test.ts` | 25/25，通过，含大业务字段、不同切点与字段历史值 |
| `node --test --test-name-pattern='publication outbox' test/batch-recovery.test.ts` | 3/3，通过，7.13 秒；含写入失败后 SQLite 快照不能丢未完成发布的故障回归 |
| `node --test test/desktop-branding.test.ts test/runtime-restart.test.ts` | 21/21，通过，37.19 秒；含静默 30 秒、续期封顶、正常退出、计时器重置、图变更和最后 seq |
| `npm run typecheck` | 通过 |
| `npx tsc -p ui/tsconfig.json` | 通过 |
| `npm run build` | 通过；桌面产物 22.9 MiB / 735 文件 / 2 个原有运行依赖包 |
| `git diff --check` | 通过 |

首次探索性 `npm test` 在并行实施期间跨越了文件版本，685 tests / 655 pass / 29 fail / 1 skip，用时 1428.7 秒；包含尚未写入 observeRecovery 时的旧失败和 Windows EPERM。该命令**不能作为阶段验收通过依据**。全部实现冻结后已重新启动正式 `npm test`，待最终结果。

性能实测：

- 完整副本 `npm run snapshot -- --project <copy>`：21.815 秒，其中全量重放 14.095 秒；factory-state 快照 137810849 bytes、写入 6.700 秒；channels 快照 721764 bytes，保持全部业务数据但只保存字段事件序号。
- 无 CLI 快照的真实桌面启动：**13.498 秒 ready**，没有被计时器杀掉，退出后六组件快照均存在，见 `v2-acceptance/A-cold.json`。
- 首轮桌面连续三次（与全套浏览器测试同时运行，空闲内存约 2.2 GiB）：**21.533 / 7.170 / 7.732 秒**，**未达到 ≤5 秒**。保留原始数据 `v2-acceptance/A-ready-under-test-load.json`，不据此通过 A。
- 仅用于定位的程序入口分段测量：import 1.178 秒，快照恢复 factory-state 1.607 秒，Factory.boot 3.242 秒；其中文档同步刷新约 1.1 秒，v1 恢复 0.052 秒。该数据不是正式桌面验收。

当前状态：继续阶段 A；等待完整测试和无并行浏览器负载的三次桌面实测。未修改 5 秒阈值，未裁剪真实历史，未进入 B。

### A 最近验证结果与范围确认

- 正式冻结后完整 `npm test`：**695 tests / 692 pass / 2 fail / 1 skip，1016.3 秒**。两项失败均为未修改的 `workflow-packs` 安装 fixture 在目录 rename 阶段遇到 Windows `EPERM`；`node --test test/workflow-packs.test.ts` 随后 **28/28 通过，15.24 秒**。完整 npm test 尚未通过，不能用定向结果替代。
- `npm run desktop:smoke`：**24 个检查全部通过**，脱敏回执 `v2-acceptance/A-smoke.json`。
- 无并行浏览器回归的第二组：**15.330 / 4.233 / 4.267 秒**，见 `A-ready-after-tests.json`，仍不满足三次全部通过。
- 补充父进程阶段接收时间日志后，重建并重新执行 CLI 的第三组：**15.350 / 4.372 / 4.352 秒**。第一轮 import 标记 166 ms，journal 标记 7729 ms；第一轮 factory-state 恢复 1787 ms。后两轮约 1 秒进入 journal。记录见 `A-ready.json`。
- 父进程阶段日志补充的定向验证：`desktop-branding` **12/12 通过**；类型检查和构建通过。新增日志只含阶段名与时间，没有路径或凭据。

**等待站长决定（§0.4）**：仅快照方案尚未满足 G1，建议追加 Playwright 按需加载及内容不变时跳过派生文档重写。具体文件、边界和验证要求见 `v2-acceptance/A-startup-followup.md`。追加方案尚未实施，阶段 B 未开始。
