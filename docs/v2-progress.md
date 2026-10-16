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

随后站长明确回复 **“允许这两项最小优化并继续”**，解除上述等待。现仅按已批准范围实施并重新验收；第三组失败数据另存 `A-ready-before-followup.json`。5 秒阈值和阶段顺序保持不变。

### 已批准追加优化的结果

- 仅 `server/browser.ts` 三个既有调用点改为按需导入 Playwright，保留共享 Promise、取消和重连；相关真实浏览器测试 **32/32 通过，45.43 秒**。
- `Docs` 在验证路径后跳过相同正文的原子重写，变化／缺失继续原流程；`Lessons` 内部视图免重复深拷贝，公共 list/get 仍深隔离。相关文档／经验测试 **25/25 通过**，追加的无写入断言 **2/2 通过**；类型检查及构建通过。
- 追加优化后再次 CLI → 桌面三次：**9.338 / 3.336 / 3.481 秒**，见 `A-ready-after-followup.json`；仍未满足每次 ≤5 秒，未进入 B。
- 为准确诊断，仅临时向生成的桌面产物添加 modules/construct 时间标记，结束后恢复产物原字节，没有修改产品源文件。诊断结果首轮 import→modules 约 **8.459 秒**，Factory 构造仅 **10 ms**；后两轮模块加载约 **0.49 / 0.55 秒**。快照恢复约 1.6–1.8 秒。诊断记录独立存放 `A-ready-profile.json`，不作为验收通过证据。
- 当前只读剖析剩余静态模块加载延迟；不追加其他依赖优化，不降低指标。最终完整 npm test、冒烟与冷／热启动验收仍须在范围稳定后执行。

### 2026-10-16 · A 模块读取证据与构建范围提案

只读剖析已完成：三个独立 Electron Node 进程只导入启动模块，不构造 Factory 或启动项目。总耗时 **6699 / 556 / 612 ms**，其中同步文件读取 **5920 / 60 / 65 ms**；195 个源码文件中第一轮 177 个加载超过 10 ms。编译时间接近，主要差异位于文件读取。脱敏证据保存为 `v2-acceptance/A-module-load-profile.json`，没有将诊断结果当作正式验收。

**等待站长决定（§0.4）**：请求仅在现有构建中用已安装的 Rolldown 打包后端启动入口及静态依赖，并保持原模块相对资源路径。完整范围及验证要求见 `v2-acceptance/A-build-followup.md`。尚未实施构建调整；A 仍未通过，B 未开始。

随后站长明确回复 **“允许构建层打包并继续（推荐）”**，解除上述等待。开始实施限定的构建层变更并验证模块资源路径；没有扩大业务范围或进入 B。

构建调整期间独立执行的源码 `npm run desktop:smoke` 未通过：首个 `.node` 等待超时。隔离 profile 的父进程日志为 import=101 ms、ready_timeout=30106 ms，未进入 journal/Factory 阶段。保留 TEMP 日志 `ew-v2-A-source-smoke-final.log`；不修改 30 秒静默计时器，不将失败算为通过，最终仍需该命令成功。

### 已批准构建调整的结果

- `scripts/build.mjs` 使用既有 Rolldown 生成 `server/bundled/main.js`，只修改生成的 runner 入口；原始分发模块和资源保留。内部字面量动态导入使用同一模块图和分块，保持共享实例与延迟执行；Node 内置模块和 Playwright 外置。用 AST 重定位原 `import.meta.url`，资源仍可随分发目录迁移。
- `node --test test/desktop-branding.test.ts` **13/13 通过，2.70 秒**；补充真实 undici 的 CommonJS 输入类型后，针对新增 bundle 回归 **1/1 通过，0.756 秒**。迁移 fixture 实际执行角色／规则读取、CommonJS 相对引用、worker、动态 pack、共享状态与懒加载。
- `npm run typecheck`、`npm run build` 和 `git diff --check` 通过。桌面产物 **26.3 MiB / 754 文件 / 2 个原有运行依赖包**。
- 完整项目副本 snapshot CLI 完成 **5.072 秒**，factory-state 恢复 **1.795 秒**、写回 **2.655 秒**；事件数仍为 **187492**。
- 构建后首组连续三次 ready 为 **5.683 / 2.867 / 2.900 秒**，**未通过**；完整记录见 `v2-acceptance/A-ready-after-bundle.json`。首轮 import→journal 已降至 **313 ms**；Factory 阶段 **3560 ms**，dispatcher 标记到 ready 仍有 **1746 ms**。继续定位其原因，不用后两次代替连续三次验收。
- 不跑 snapshot CLI 的分发桌面全量启动 **9.831 秒 ready**，全量重放 **5.423 秒**，正常退出后六类快照齐全；见 `A-cold.json`，旧数据保留为 `A-cold-before-bundle.json`。
- `npm run desktop:smoke -- --app=dist/desktop --standalone` **25 个检查全部通过**；见脱敏回执 `A-packaged-smoke.json`。该模式不连接原 VisLexicon 资料，实际验证分发资源、后端 Playwright 按需加载和本地浏览器操作。额外日志审查发现 **2 条资源加载警告**，正在定位；smoke 检查通过不能证明所有样式资源完整。

两条资源警告均为原构建复制清单漏掉 `style-contract.mjs`。已在已批准的构建范围补充原样复制，构建通过（**755 文件 / 26.3 MiB**），源和副本 SHA-256 一致，直接导入分发 site-style.mjs 成功，checkStyle/salvage 导出存在；未修改规则正文或原仓库。

进一步独立诊断发现 `Factory.boot → warmStyleLib → common.mjs → Playwright` 绕过 browser.ts 的按需加载。与正式连接资料配置相同的诊断里，listen=2489.5 ms、style完成=2932.0 ms、ready发送=2946.2 ms；ready 前案卷回填回调为 0。没有复现首轮 1746 ms 差额，不能将其全部归因；但确认该动态链会推迟 listen 回调。生成产物的诊断改动均已按原字节恢复。

**等待站长决定（§0.4）**：请求只取消 Factory.boot 主动预热，样式节点继续首次使用时按原路径 await 加载校验库。具体边界与验证见 `v2-acceptance/A-style-load-followup.md`。本项尚未实施，完整 npm test 和源码 smoke 仍未获得最终通过，A 未通过、B 未开始。

## 2026-10-16 · 站长调整执行顺序：先完成 B/C/D/E

站长明确要求：**“我不是让你死扣这个时间……先把后面 BCDE 全做完……这三四秒倒是无所谓的”**。据此停止 A 的追加性能优化，取消以 A 的 5 秒结果阻塞后续开发。A 的失败实测保留，不伪标通过；样式主动预热提案不再继续实施。

现在按 B → C → D → E 完成功能、定向验证和分阶段提交，真实模型长运行验收单独记录，未完成者明确标注。按本次“BCDE 全做完”的新指令接手 E 的必要界面接入（保留现有视觉，不额外重设计）。默认内核暂保留 v1，v2 通过显式开关在项目副本验证，不切换真实项目。

### B.11 / B.14 接入盘点

命令：`rg -n "ctx\.token\." server packs`；`rg -n "runtime\.\w+" server ui`。

执行器直接读取的 TokenRun 字段：`data`、`id`、`item`、`source`、`title`、`url`。适配器仍完整提供 B.11 指定的 done/dead/inflight/rounds/epoch/notes 和 closure 等上下文字段。

外部 runtime 成员去重：`atomicTransition`、`checkpoint`、`close`、`closureOf`、`correct`、`create`、`decideMeasurement`、`descendants`、`end`、`ending`、`ensureWorkers`、`executors`、`fork`、`intakeHold`、`lineTakt`、`locked`、`maxActiveItems`、`measurementProposal`、`nodes`、`occupiesAdmission`、`onAlert`、`onPark`、`onRecovery`、`onTick`、`outFlow`、`parkRecovery`、`pause`、`paused`、`pausedLines`、`pausedStations`、`queues`、`readyFrontier`、`recover`、`restoreCheckpoint`、`restoreFlow`、`resume`、`resumeFrontier`、`retire`、`roleResolver`、`runnable`、`running`、`sampleItems`、`schedule`、`scopePaused`、`selectedModelDependency`、`setScopePaused`、`setWorkerLock`、`settle`、`start`、`stationNumbers`、`stock`、`stockDelta`、`tick`、`toManual`、`tokens`、`ts`、`undoCorrection`、`workers`。

额外辅助（B.14 表外）按最小兼容处理：保留纯图查询；token/queue 为兼容视图，显式 checkpoint 将变更回写 items；v2 停用旧 Batch/Recovery 调度和旧 Channel 消费，由 Kernel 独立完成入场、重试和跨线投递，避免直接写 v1 视图形成第二套状态。旧功能入口逐一验证并保留 v1 分支。

### B 实现与定向验证

已增加 `server/kernel/{item,store,scheduler,retry,kernel}.ts`，同一 journal.db 中维护 items/attempts。Factory 三处构造通过显式 v2 选择；默认 v1 不变。v2 无 worker/measurement/consult/batch.configured 事件，跨线按稳定货 id 幂等创建，旧消费者与恢复监督器在 v2 禁用。设置 maxActiveItems 默认 12，迁移 CLI 支持只读 dry-run 和重复执行保留已有记录。

| 命令／场景 | 结果 |
|---|---|
| `node --test --test-concurrency=1 test/kernel-graph.test.ts test/kernel-retry.test.ts` | **32/32，通过，3.075 秒**；含真实 v1/v2 策展图 8 组合、退回／fix／人工撤销、FIFO／资源、迟到结果丢弃、跨线幂等、重试全表及单模型试探 |
| `node --test --test-name-pattern='v2 ' test/runtime-restart.test.ts` | **4/4，通过，8.643 秒**；两个真实 SIGKILL operation receipt 边界、独立 SQLite 读者事务可见性、故障回滚 |
| `node --test --test-name-pattern='kernel migration' test/journal-atomic.test.ts` | **1/1，通过，21.31 秒**；dry-run 主数据库字节不变、checkpoint／manual 原因保留、重复迁移不覆盖 |
| `node --test --test-name-pattern='Factory selects v2' test/journal-atomic.test.ts` | **1/1，通过，4.49 秒**；实际 Factory 启动、status API、完成投影、禁旧事件及 410 |
| `npm run typecheck` | 通过，含服务端与 UI |
| `npm run build` | 通过；**26.5 MiB / 760 文件 / 2 个原有运行依赖包** |

完整 npm test 留待本次 B/C/D/E 功能固定后统一验证；分发 v2 桌面冒烟正在执行。真实模型 30 站与 60 秒状态记录尚未执行，**不把上述 fixture 结果冒充 B.17 通过**。按站长最新顺序要求进入 C 实现，默认切换与真实项目切换均未进行。
