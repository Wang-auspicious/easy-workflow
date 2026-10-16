# Easy Workflow v2 · 内核、Agent 线程、协作面板与主调度复盘

> 版本 v2-draft-1 · 2026-10-15 · 起草：Claude（站长确认方向后交 Codex 执行）
> 本文件是 v2 改造的**唯一执行依据**。与 `Spec.md` 冲突时，以本文件为准，只限 v2 涉及的部分。
> 执行者只照本文做：本文没写的不做，写了“禁止”的不做。遇到本文没覆盖的情况，按 §0.4 处理，不自行设计。

---

## 0. 给执行者的规则（先读完再动手）

### 0.1 改造目标（只有这五件）

| 编号 | 目标 | 一句话验收 |
|---|---|---|
| G1 | 启动快 | 13.6 万事件的真实项目副本，桌面后端 ready ≤ 5 秒 |
| G2 | 不卡住 | 30 个网站无人值守跑完；没有任何一件货在“不等资源”的情况下超过 10 分钟没有状态变化 |
| G3 | Agent 线程完整 | agent 节点只能通过 `submit` 或 `handoff` 结束，不再出现“模型没有提交结果”的失败 |
| G4 | 协作面板 | 每件货有一块黑板；审查质疑通过黑板回到原会话；有分歧时开讨论室，限 3 轮 |
| G5 | 主调度复盘 | 定期分析运行数据，提出白名单内的补丁，先金丝雀再推广或回滚 |

### 0.2 阶段顺序（严格按顺序；前一阶段验收通过才进入下一阶段）

A 启动快照 → B 新内核 → C Agent 线程契约 → D 黑板与讨论室 → E 三条消息流（UI）→ F 主调度复盘

每个阶段单独提交（一个或多个 commit），提交信息前缀写 `v2(A):`、`v2(B):`……，并在 `docs/v2-progress.md` 追加一段：做了什么、跑了哪些命令、数字结果。

### 0.3 禁止

1. 禁止删除 v1 代码（`server/runtime.ts`、`server/recovery.ts`、`server/batch.ts`、`server/broker.ts` 等）。v2 用开关切换（§B.1），v1 保持可运行。
2. 禁止修改 VisLexicon 仓库（`D:\Desktop\VisLexicon  视元`）的任何文件，禁止改动规则资料。
3. 禁止修改任何节点的验收条件（`accept`）、闸门逻辑（`curation.gate`）、输出 schema 和校验器。
4. 禁止新增数据库或消息队列。只用现有的 `journal.db`（`node:sqlite`），新表建在同一个文件里。
5. 禁止引入新的 npm 依赖。只有确实无法实现时，在 `docs/v2-decisions.md` 写明理由，然后停下来等站长确认。
6. 禁止把密钥、token、个人绝对路径写进代码、日志、测试快照或提示词。
7. 禁止为了让测试通过而放宽断言或删除测试。
8. 禁止在真实项目目录上做破坏性实验。所有实验都在**项目副本**上做（§0.5）。
9. 禁止加入本文没写的功能、开关、重构或“顺手优化”。

### 0.4 遇到本文没覆盖的情况

- 选择最简单、对现有行为改动最小的做法；
- 在 `docs/v2-decisions.md` 追加一条：`日期 · 阶段 · 问题 · 选择 · 理由`；
- 如果这个选择会影响 0.1 的验收结果，就停下来，在进度文件里写“等待站长决定”，然后不再继续。

### 0.5 测试项目副本

- 真实项目可能在 `%USERPROFILE%\Documents\Pi Factory\Projects\vislexicon-curation` 或 `%USERPROFILE%\Documents\Easy Workflow\Projects\<名>`。先只读确认路径，再整个目录复制到 `%TEMP%\ew-v2-copy-<日期>\`，此后只用这个副本。
- 用 `FACTORY_VAR` 指向副本运行。真实项目只在站长明确同意后才能切换。

### 0.6 代码风格

遵守仓库 `AGENTS.md`：Google TypeScript 风格，两空格缩进，单引号，`const` 优先，具名导出，边界数据用 `unknown` 接收再校验。保留 NodeNext、原生 `.ts` 加载、`erasableSyntaxOnly`。新测试优先加进已有的测试文件；本文点名要新建的测试文件才可以新建。

---

## 阶段 A · 启动快照（G1）

### A.1 现状（已查明，不用再查）

`Factory.boot()`（`server/factory.ts` 约 104–118 行）用 `for (const e of this.journal.read(0))` 把全部事件逐条 `apply()` 到 `FactoryState`，同时调用 `this.docs.observeReplay(e)`。启动时还有以下几处整段历史遍历（见 `.learnings/proof-supplement-round-backup/startup-readonly-findings.md`）：

1. `Factory.boot` 状态投影（factory.ts 约 114 行）
2. `completedRuns` 收集（同一循环）
3. `Docs.catchup`（server/docs.ts）
4. `Lessons` 的索引与历史（server/lessons.ts 约 156、168–170 行）
5. `ChannelSupervisor` 构造函数（server/channels.ts）
6. `SourceSupervisor` 构造函数（server/sources.ts）
7. `PublicationOutbox` 构造函数（server/publication-outbox.ts）

桌面主进程 `app/main.cjs` 有一个 30000 ms 的硬性 ready 计时器。

### A.2 先盘点（第一个提交只做这件事）

用 `rg -n "read\(0" server shared` 以及阅读上面 7 个构造函数，列出**所有**启动时的全历史遍历，写进 `docs/v2-progress.md`：文件、函数、读了哪些事件 kind、产出什么内存结构。列表必须包含上面 7 处；如果多出来，照样列出。

### A.3 快照表

在 `journal.db` 中新建表（在 `Journal` 构造函数里 `CREATE TABLE IF NOT EXISTS`）：

```sql
CREATE TABLE IF NOT EXISTS snapshots (
  name TEXT NOT NULL,          -- 'factory-state' | 'docs' | 'lessons' | 'channels' | 'sources' | 'outbox'
  seq INTEGER NOT NULL,        -- 快照包含的最后一个事件 seq
  version TEXT NOT NULL,       -- 见 A.4
  at INTEGER NOT NULL,
  body TEXT NOT NULL,          -- JSON
  PRIMARY KEY (name, seq)
);
```

`Journal` 新增方法：

```ts
writeSnapshot(name: string, seq: number, version: string, body: string): void;   // 写入后只保留该 name 最新 3 份
latestSnapshot(name: string, version: string): {seq: number; body: string} | null;
```

### A.4 版本号

`version = sha256(PROJECTION_VERSION + ':' + compiled.digest).slice(0, 16)`。`PROJECTION_VERSION` 是一个手写常量字符串，放在 `shared/project.ts`，初始值为 `'p1'`。以后只要 `apply()` 的语义有变，就必须把这个常量加一。版本不匹配的快照一律忽略。

### A.5 可快照接口

每个启动时遍历历史的组件都实现：

```ts
export interface Snapshottable {
  readonly snapshotName: string;
  serialize(): string;                 // JSON；Map/Set 用 {"$map":[[k,v]...]} / {"$set":[...]} 编码
  restore(body: string): void;
  observe(event: Stamped): void;       // 与原 replay 逻辑完全一致
}
```

`FactoryState` 的序列化写在 `shared/project.ts`：`serializeState(state)` 和 `deserializeState(body)`。要求 `deserializeState(serializeState(s))` 与 `s` 深度相等（`assert.deepStrictEqual`）。

`completedRuns` 改为一次索引查询，不再遍历：`SELECT DISTINCT run FROM events WHERE kind = 'run.ended'`（`events_kind` 索引已存在）。

### A.6 启动流程（替换 factory.ts 约 112–118 行）

```
for each Snapshottable c (固定顺序：factory-state, docs, lessons, channels, sources, outbox):
  snap = journal.latestSnapshot(c.snapshotName, version)
  if snap: c.restore(snap.body); from = snap.seq + 1
  else: from = 1   // 首次升级：全量重放
tail = journal.read(min(from of all))
for e in tail: 对每个 c，若 e.seq >= c.from 才 c.observe(e)
```

所有组件共用**一次**尾部读取，不允许每个组件各读一遍。

### A.7 什么时候写快照

- 后台每新增 5000 个事件，或距离上次写快照满 10 分钟（以先到者为准），且当前不在 `journal.atomic` 事务里时，写一次全部快照；
- 正常退出（`Factory.close` / 桌面退出）时写一次；
- 全量重放完成后立即写一次；
- 写快照放进 `setImmediate`，单次耗时记日志 `boot.snapshot name=<> ms=<> bytes=<>`。

### A.8 首次升级与桌面计时器

- 新增 CLI：`npm run snapshot -- --project <目录>`。它离线完成全量重放并写快照，打印每一阶段的耗时。
- `app/main.cjs`：后端在启动各阶段通过 stdout 打印 `BOOT_STAGE <名> <毫秒>`。主进程每收到一行，就把 ready 计时器再延长 30 秒，总上限 180 秒。没有任何输出时，仍然 30 秒超时。

### A.9 测试（加进 `test/journal-atomic.test.ts`）

1. 构造约 2 万个事件的 fixture（用已有的 fixture 生成方式），在 seq = 5000、12000、20000 三个切点写快照；对每个切点，“快照 + 尾部重放”得到的状态必须与“全量重放”深度相等。
2. 版本不匹配时快照被忽略，结果仍然正确。
3. 快照损坏（body 不是合法 JSON）时，回退到全量重放，并在日志中报告，进程不崩溃。

### A.10 验收

- 项目副本（约 13.6 万事件）：先跑 `npm run snapshot`，再启动桌面，从启动到 ready ≤ 5 秒。连续测 3 次，记录每个阶段的耗时。
- 不跑 snapshot CLI 直接启动：允许超过 30 秒，但不能被计时器杀掉，并且完成后写出快照。
- `npm test`、`npm run typecheck`、`npm run build`、`npm run desktop:smoke` 全部通过。

---

## 阶段 B · 新内核：每件货一个状态机（G2）

### B.1 开关与文件

- 开关：环境变量 `FACTORY_KERNEL=v2`，或者项目设置 `kernel: 'v2'`。默认仍是 v1，阶段 B 验收通过后再改默认值。
- 新文件全部放在 `server/kernel/`：
  - `item.ts`：`ItemState` 类型和纯函数状态转移，不做 I/O；
  - `store.ts`：SQLite 读写；
  - `scheduler.ts`：资源信号量和就绪选择；
  - `retry.ts`：重试策略；
  - `kernel.ts`：`class Kernel`。它的构造函数与 `Runtime` 相同：`(compiled, journal, broker, conditions, executors)`。
- `Factory`（factory.ts 约 203、301、1311 行）在开关为 v2 时创建 `Kernel`，否则创建 `Runtime`。

### B.2 图定义不变

继续使用现有 pack（`packs/vislexicon/pack.ts`）和 `server/spec/compile.ts` 的编译结果：节点、`flow` 边、`when` 条件、`returnTo`/`maxRounds`、`resource`、`tool`、`prompt`。**`workers` 字段在 v2 中不再使用**（保留在数据里，不要删）。

### B.3 执行器不变

继续使用 `Executor = (ctx: StationContext) => Promise<StationResult>`，以及 factory.ts 约 143 行的 `executors(n)` 注册表。`Kernel` 需要构造出与 v1 字段相同的 `StationContext`：

- `worker` 字段传一个合成对象 `{id: 'k-'+attemptId, label: n.name, node: n.key, busy: itemId, idleSince: 0}`；
- `token` 字段传 `ItemState` 到 `TokenRun` 的只读适配（B.11）。

### B.4 数据表（建在 `journal.db`）

```sql
CREATE TABLE IF NOT EXISTS items (
  id TEXT PRIMARY KEY,         -- 与 v1 token id 同格式
  run TEXT NOT NULL,
  line TEXT NOT NULL,
  status TEXT NOT NULL,        -- 'queued'|'active'|'published'|'parked'|'excluded'|'cancelled'
  admitted_at INTEGER,         -- 进入 active 的时间；排序用
  updated_at INTEGER NOT NULL,
  body TEXT NOT NULL           -- ItemState JSON
);
CREATE INDEX IF NOT EXISTS items_status ON items(status, admitted_at);

CREATE TABLE IF NOT EXISTS attempts (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  node TEXT NOT NULL,
  started_at INTEGER NOT NULL,
  ended_at INTEGER,
  status TEXT NOT NULL,        -- 'running'|'ok'|'failed'|'interrupted'|'handoff'|'cancelled'
  body TEXT NOT NULL           -- 摘要、错误、用量、预算、证据 id
);
CREATE INDEX IF NOT EXISTS attempts_node ON attempts(node, ended_at);
```

**每一次状态变化**都在 `journal.atomic(() => {...})` 中同时完成两件事：写 `items` 表、追加与 UI 兼容的事件（B.10）。模型调用和外部 I/O 一律在事务之外完成（现有规则）。

### B.5 ItemState

```ts
export type NodeStatus = 'pending' | 'ready' | 'running' | 'waiting' | 'done' | 'skipped' | 'failed';
export interface NodeState {
  status: NodeStatus;
  attempts: number;            // 本轮自动尝试次数（重试计数）
  rounds: number;              // 被退回重做的次数
  nextAt?: number;             // waiting 时，最早可再试的时间
  waitingFor?: 'backoff' | 'model' | 'resource' | 'budget' | 'room' | 'supervisor';
  lastFailure?: Failure;       // shared/failures.ts
  lastAttempt?: string;
  session?: SessionRef;        // agent 会话引用；退回时复用（阶段 C）
  redo?: {reason: string; note?: string; byHuman: boolean};
}
export interface ItemState {
  version: 1;
  id: string; run: string; line: string; entry: string;
  item: string; url: string; title?: string; source: string;
  data: Record<string, unknown>;
  nodes: Record<string, NodeState>;   // 只含 closure 内节点
  status: 'queued' | 'active' | 'published' | 'parked' | 'excluded' | 'cancelled';
  parked?: {node: string; reason: string; code: string; at: number};
  canary?: string;                    // 阶段 F：所属补丁 id
  createdAt: number; updatedAt: number;
}
```

`closure` 的计算方式与 v1 的 `Runtime.closureOf(entry)` 相同，直接调用 v1 的同名逻辑，或者复制成纯函数。

### B.6 就绪规则（必须照此实现）

记 `inc(n)` = 指向 n 的全部 `flow` 边，且起点在 closure 内。

1. 新建货：entry 节点设为 `ready`，其余设为 `pending`。
2. 节点 n 处于 `pending` 时，如果 `inc(n)` 的每条边的起点都已是 `done` 或 `skipped`：
   - 至少有一条边起点为 `done`，且 `when` 条件为真（无条件视为真）→ n 变为 `ready`；
   - 否则 → n 变为 `skipped`。随后对 n 的下游重新执行本规则。
3. 条件函数使用 `pack.conditions[when](item.data)`，与 v1 相同。
4. 节点完成：`item.data = {...item.data, ...result.data}`，n 变为 `done`，然后对 n 的所有下游执行规则 2。
5. 到达 store 节点：`published` → 货的状态改为 `published`；`manual` → 货的状态改为 `parked`，原因 `code='manual_store'`。
6. 结果带 `finish`（重复、不可达等）→ 货的状态改为 `excluded`，同时写出原有的 candidate disposition 事件。

**黄金测试（必做，新建 `test/kernel-graph.test.ts`）**：对策展线，用假执行器覆盖 4 种条件组合（shots/video × needsProof/noProof，再加 agree/disagree）。断言 v2 的节点完成顺序集合（拓扑层次）和最终到达的 store，与 v1 `Runtime` 在同样假执行器下的结果完全一致。

### B.7 退回

审查结果为 `verdict: 'return'` 且带 `returnTo = X` 时：

1. `nodes[X].rounds += 1`。若超过该边的 `maxRounds` → 货改为 `parked`，`code='max_rounds'`，到此结束。
2. 把 X 以及 X 在 closure 内经 flow 可达的全部下游节点重置为 `pending`；X 直接设为 `ready`。**保留**这些节点的 `session` 和 `rounds`。
3. `nodes[X].redo = {reason, note, byHuman: false}`，执行时通过 `ctx.redo` 传给执行器（v1 已有这个字段）。
4. `data` 不清空；下游重跑时会覆盖自己的输出键。

审查结果为 `verdict: 'fix'` 且带 `fixes[]` 时（阶段 B 先这样处理；阶段 D 改走黑板）：

- 取 `fixes` 中拓扑序最靠前的 `station` 作为 X，把所有 fix 的 `problem` 用换行拼成 reason，按“return”同样处理。审查节点自身也在下游，会自动重跑。

人工纠错（UI 上的“拍错了”）：按 return 处理，`byHuman: true`，**不计入** rounds。

### B.8 调度

- 资源信号量来自 `Settings`：`browser`、`model`（用 `modelWorkers` 的值）、`cpu`、`http`。资源为 `none` 的节点不限并发。直接用现有 `Broker` 的 `acquire/tryAcquire`，不新写信号量。
- 入场：设置项 `maxActiveItems`，默认 12。超出的货保持 `queued`。active 数量低于上限时，按 `created_at` 先到先入。
- 选择顺序：每次调度（事件触发，或 1 秒定时器）收集所有 `ready` 节点，排序键为 `(item.admitted_at 升序, 节点拓扑序号 升序)`。**老货优先**，让货尽快走完，避免所有货都做了一半。
- 对每个 ready 节点：`tryAcquire(resource)` 成功就启动；失败就跳过，继续看下一个。资源不足时不让节点进入 `waiting`，它保持 ready，下一轮再看。
- `waiting` 的节点在 `nextAt` 到达后自动变回 `ready`。
- 全局暂停 / 线暂停 / 工位暂停：调度时跳过即可，不改变节点状态。

### B.9 重试（`server/kernel/retry.ts`）

失败分类沿用 `shared/failures.ts` 的 `classifyFailure`。

| 标签或情况 | 处理 |
|---|---|
| `network_timeout` `network_connection` `network_dns` `http_server` `http_rate_limit` `browser_capture` `tool_error` | 自动重试：`attempts < 3` 时退避 10s、30s、90s（×3，上限 10 分钟）后回到 ready；用尽后 parked，`code='retries_exhausted'` |
| `model_transport`、`model_unavailable`（非认证类） | 节点进入 `waiting`，`waitingFor='model'`，并通知模型熔断（B.9.1）。**不计入** attempts |
| `auth`、TLS、`http_forbidden`、`EXTERNAL_OPERATION_UNKNOWN` | parked，`code=` 对应标签，并进入注意流（阶段 E） |
| 404 / 410 等“网址无效” | 货改为 `excluded`，写 disposition |
| `needs_selection`、`page_unavailable`（需要重新选页） | 按退回处理：退回到 reader（`curation/reader`），附失败原因，计入 rounds |

节点可以声明 `StationSpec.recovery`（v1 已有字段）：声明了就按声明的 `maxRetries/backoff` 执行，未声明的部分用上表的默认值。

#### B.9.1 模型熔断（简化版，替代 v2 下的恢复监督器）

- 依赖键直接用 v1 已有的 `ModelDependency` 摘要（model-circuits.ts 中已有计算方式，复用该函数）。
- 某个依赖出现失败 → 状态改为 `down`，退避 30s、60s、120s……上限 15 分钟。
- `down` 期间，所有需要这个依赖的 ready 节点都改为 `waiting(model)`。
- 退避到期后只放行**一个**节点作为试探。成功则依赖改为 `up`，其他等待的节点全部变回 ready；失败则进入下一档退避。
- 依赖 `down` 不阻塞程序节点和其他依赖。

### B.10 与 UI 兼容的事件

为了让现有画布和报告继续可用，Kernel 在同一事务中追加 v1 的事件（`shared/types.ts` 已有定义）：

| 时机 | 事件 |
|---|---|
| 新建货 | `token.created` |
| 节点变为 ready | `token.queued` |
| 开始执行 | `attempt.started` |
| 执行中 | `attempt.progress` / `attempt.activity`（直接转发执行器的回调） |
| 执行结束 | `attempt.finished`，然后 `token.data`（只放本次新增的键） |
| 退回 | `token.returned` |
| 货终结 | `token.finished`（status 映射：published→published，parked→manual，excluded→按原来的 disposition） |
| 证据 | `evidence.added`（执行器调用 `ctx.addEvidence` 时） |

**v2 不再发出**：`worker.spawned/forked/retired/locked`、`measurement.*`、`consult.*`（阶段 D 改用新事件）、`batch.configured`。UI 对这些事件缺失必须能正常显示，不报错。

### B.11 TokenRun 适配

执行器读取 `ctx.token` 的哪些字段，先全部列出：用 `rg -n "ctx\.token\." server packs`，把结果写进进度文件。然后写一个只读适配函数 `asTokenRun(item: ItemState): Readonly<TokenRun>`，把上述字段全部填上：

- `done`/`dead`/`inflight`：由 nodes 状态推出；
- `rounds`：由 `nodes[k].rounds` 推出；
- `epoch`：固定为 0；
- `notes`：由 `nodes[k].redo` 推出。

### B.12 崩溃恢复

启动时（阶段 A 的快照恢复完成之后）：

1. 读取 `items` 表中所有 `active` 的货；
2. 每个处于 `running` 的节点 → 对应 attempt 标记为 `interrupted`，节点改回 `ready`，**不计入** attempts；
3. 外部副作用依赖现有的 operation receipt（`server/operations.ts`）防止重复执行，这部分不改动。

### B.13 信道（跨线）

线 A 的节点完成时，若有指向线 B 的 `channel` 边：新建一件线 B 的货，`id = <A货id>:<B线id>`。如果同 id 的货已经存在，则不重复创建（幂等）。新货的 `data` 等于该边声明的输入映射；没有声明时，复制 `item/url/title` 加上完成节点的输出。

### B.14 v1 Runtime 公开方法在 v2 的对应

先用 `rg -n "runtime\.\w+" server ui` 列出所有外部调用，逐个归入下表；表里没有的，按 §0.4 处理。

| v1 方法 | v2 |
|---|---|
| `start/pause/resume/end/tick/dispose/close/settle/schedule` | 同名同语义 |
| `create(entry, item)` | 新建货，status=queued |
| `setScopePaused/scopePaused` | 同语义 |
| `returnToken/correct/undoCorrection` | 按 B.7 |
| `toManual/parkRecovery` | 改为 parked |
| `ensureWorkers/setWorkerLock/balance/fork/retire/measurementProposal/decideMeasurement/lineTakt/resourceAllocations` | **删除功能**：方法保留，返回 `ControlError(410, 'removed_in_v2', 'v2 不再按工人配比，并发由资源上限决定')`；UI 中对应的按钮在 v2 下隐藏 |
| `stationNumbers(key)` | 从 items 中统计：ready / running / waiting / done(本轮) / parked |

### B.15 迁移已有项目中未完成的货

新增 CLI：`npm run kernel:migrate -- --project <目录> [--dry-run]`

- 读取 v1 投影中所有未完成的 token；
- token.data 中有合法的 v1 `runtimeCheckpoint`（version 1）时：其 `done` 中的节点设为 done，`rounds` 照搬，其余节点按 B.6 计算；
- 没有合法 checkpoint 时：从 entry 重新开始（证据和网络缓存会降低重复成本）；
- 已在 manual 的货迁移为 parked，原因照搬；
- `--dry-run` 只打印每件货迁移后的状态统计，不写库。

### B.16 测试

- `test/kernel-graph.test.ts`（新建）：B.6 的黄金测试；B.7 的退回与轮数上限；`fix` 的转换规则。
- `test/kernel-retry.test.ts`（新建）：B.9 表格中每一行至少一个用例；熔断只放行一个试探节点。
- 已有 `test/runtime-restart.test.ts` 加 v2 分支：执行过程中强杀后重启，done 的节点不重做，running 的节点恢复为 ready，副作用不重复。

### B.17 验收（项目副本 + 真实模型）

1. 投 30 个站（使用副本候选库中未发布的前 30 个），设 `maxActiveItems=12`，无人值守运行。
2. 运行期间每 60 秒记录一次 `items` 表的状态统计，写到 `docs/v2-acceptance/B-30sites.jsonl`。
3. 判定通过需要同时满足：
   - 任何一件货，在“不处于 waiting(model) 或资源不足”的情况下，`updated_at` 都不超过 10 分钟不变；
   - 30 件全部终结（published / parked / excluded）；
   - parked 的每一件都有 `code` 和 reason。
4. 运行中随机强杀进程 3 次，每次 10 秒内恢复运行，最终没有重复发布。
5. 报告中写明：总耗时、发布数、每个发布站的 token 数（对照基线：截图中的 4692.8 万 token / 108 站 ≈ 43 万/站）。

---

## 阶段 C · Agent 线程契约（G3）

改动集中在 `server/agent-station.ts`（`executeAgentStation`）。

### C.1 现状（已查明）

- `MAX_TOOL_CALLS = 10`（约 86 行），超过直接失败；
- 没有调用 `submit` 时只提醒一次（约 466–472 行），之后返回 `ok:false, error:'no submit'`；
- 会话通过 `saveStationSession` 保存（约 380 行）。

### C.2 新规则

1. **结束方式只有两种**：`submit`（正常提交）和 `handoff`（预算用完时交接）。
2. **删除 `MAX_TOOL_CALLS` 的硬上限**，改用预算：
   ```ts
   interface AgentBudget { maxTokens: number; maxMs: number }
   ```
   - 默认 `maxTokens`：该节点最近 50 次成功 attempt 的 token 中位数 × 5；样本不足 10 次时取 60000。
   - 默认 `maxMs`：15 分钟；下限 3 分钟。
   - 节点可在 pack 中覆盖；阶段 F 的补丁可以在默认值的 0.5×–3× 范围内调整。
3. **漏交提醒**：模型停止输出但没有调用 submit 时，在同一会话中提醒，最多 3 次。提醒原文固定为：
   `你还没有调用 submit。请先对照下面的自检清单逐条确认，然后调用 submit 提交。若无法完成，调用 handoff 说明已完成的部分和缺失的部分。` 后面附上该节点的 `accept` 列表。
   3 次之后仍未调用 → 按预算耗尽处理（第 5 条）。
4. **提交前校验**：`submit` 的参数先经过现有的 schema 校验和程序检查。不通过时，把错误作为工具结果返回到**同一会话**，最多修复 3 轮（现有修复逻辑的上限改为 3）。3 轮后仍不通过 → 按预算耗尽处理。
5. **预算耗尽**（token 或时间达到 90%）：向会话追加一条消息，要求调用 `handoff`。`handoff` 工具的 schema：
   ```ts
   {done: string[]; evidence: string[]; remaining: string[]; suggestion: string}  // 每项 ≤ 500 字
   ```
   达到 100% 时，如果仍未调用 handoff，由程序生成一份 handoff：`done=[]`，`remaining=[节点 accept 列表]`，`suggestion='模型未能在预算内完成'`。
   handoff 的结果：attempt 记为 `status='handoff'`，节点进入 `waiting`，`waitingFor='budget'`，交给主调度（阶段 F）处理。阶段 F 实现之前，UI 注意流中显示，人工点击“继续”时预算 ×2，并恢复**同一会话**。
6. **退回时续接原会话**：节点被退回（B.7）后再次执行时，如果 `nodes[k].session` 存在，且会话签名（`sessionSignature`）未变，就加载原会话，追加一条用户消息：`审查退回：<reason>\n<note>`，然后继续。签名已变（角色文件改过）时才新开会话，并在首条消息中附上一次 attempt 的 submit 内容摘要（≤ 2000 字）。
7. attempt 的 body 记录：`budget`、实际用量、轮数、提醒次数、修复轮数、结束方式（`submit` / `handoff` / `forced_handoff`）。

### C.3 测试（加进 `test/station-safety.test.ts` 或 `test/agent-adapter.test.ts`）

使用假模型（现有 fixture 方式）：

1. 模型 2 次不交 → 提醒后第 3 次提交 → 成功。
2. 模型始终不交 → 3 次提醒后得到 forced handoff，节点进入 waiting(budget)。
3. submit 校验连续 2 次失败，第 3 次通过 → 成功。
4. 模型调用 15 次工具后提交，预算充足 → 成功（证明 10 次上限已经取消）。
5. 退回后续接：第二次执行的会话消息里包含第一次的历史和退回原因。

### C.4 验收

阶段 B 的 30 站跑完后统计：`no submit` 失败为 0；列出 handoff 和 forced_handoff 的次数及其所在节点。

---

## 阶段 D · 黑板与讨论室（G4）

### D.1 数据表

```sql
CREATE TABLE IF NOT EXISTS board_posts (
  id TEXT PRIMARY KEY,
  item TEXT NOT NULL,
  seq INTEGER NOT NULL,        -- 本货内递增
  at INTEGER NOT NULL,
  author TEXT NOT NULL,        -- 节点 key | 'program:<节点key>' | 'supervisor' | 'user'
  type TEXT NOT NULL,          -- 'claim'|'challenge'|'answer'|'question'|'evidence'|'resolve'|'note'
  field TEXT NOT NULL,         -- 关注的数据键，如 'shots.proof'、'kind'、'style'、'facts.license'
  target TEXT,                 -- 回复哪一条 post
  addressee TEXT,              -- 指名的节点 key
  room TEXT,                   -- 所属讨论室 id（可空）
  round INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,          -- 自然语言，≤ 2000 字
  evidence TEXT NOT NULL,      -- JSON 数组：evidence id
  status TEXT NOT NULL         -- 'open'|'resolved'|'rejected'|'superseded'
);
CREATE INDEX IF NOT EXISTS board_item ON board_posts(item, seq);

CREATE TABLE IF NOT EXISTS rooms (
  id TEXT PRIMARY KEY, item TEXT NOT NULL, field TEXT NOT NULL, topic TEXT NOT NULL,
  participants TEXT NOT NULL,  -- JSON 节点 key 数组（2–3 个）
  judge TEXT NOT NULL,         -- 节点 key 或 'program:<名>'
  max_rounds INTEGER NOT NULL DEFAULT 3,
  round INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,        -- 'open'|'resolved'|'judged'|'parked'
  opened_at INTEGER NOT NULL, closed_at INTEGER, outcome TEXT
);
```

每次写入都在事务中同时追加 journal 事件 `board.posted` / `room.opened` / `room.round` / `room.closed`。事件类型定义加在 `shared/types.ts` 的 JournalEvent 联合类型里，body 与表行相同。

### D.2 字段归属

每个节点拥有它写入 `data` 的那些顶层键：取 pack contract 中的 `outputKey`；没有声明时，取该节点最近一次结果 `data` 的键名集合。归属表在编译后计算一次，结果写进进度文件供检查。

### D.3 自动 claim

任何节点成功完成后，程序为它拥有的每个字段自动发一条 `claim`：

- `author = 节点 key`（程序节点用 `program:<key>`）；
- `body = result.summary`（截断到 300 字）；
- `evidence` = 本次 attempt 产生的证据 id。

同一字段之前的 claim 全部改为 `superseded`。

### D.4 Agent 新工具

所有 agent 节点（包括审查节点）都会得到以下两个工具，通过现有 toolbox 机制注入（`server/toolbox.ts`），属于本工位能力，不暴露全局调度。

```ts
board_read({field?: string; openOnly?: boolean}): BoardPost[]   // 本货最近 40 条，按 seq 升序
board_post({type: 'challenge'|'answer'|'question'|'evidence'|'note';
            field: string; addressee?: string; target?: string; body: string; evidence?: string[]}): {id: string}
```

权限：

- 只有 `kind` 为 review 或 agent 的节点可以发 `challenge`；
- `addressee` 必须是该字段的归属节点；
- `answer` 必须带 `target`，并且 target 是发给自己的 challenge 或 question。

### D.5 质疑（challenge）的效果，替代阶段 B 的 fix 转换规则

审查节点结束时，可以不再返回 `verdict:'fix'`，而是发出若干条 challenge 后 submit `verdict:'return'`。也兼容旧方式：`fix` 结果由程序自动转换成 challenge（每个 Fix 一条，`addressee=fix.station`，`field=fix.fields[0]`，`body=fix.problem`）。

之后：

1. 取所有 open 的 challenge 中，`addressee` 拓扑序最靠前的节点 X，按 B.7 退回到 X，`redo.reason` 等于发给 X 的全部 challenge 正文。
2. X 在原会话中续接（C.2 第 6 条），会话里会带上这些 challenge。X 只有两种处理：
   a. **改正**：重新 submit。程序自动发新的 claim，并把这些 challenge 标为 `resolved`；
   b. **不同意**：对某条 challenge 发 `answer`，说明理由并附证据，然后 submit 原结果。程序检测到“被 answer 反驳的 challenge” → 为该字段开讨论室（D.7）。
3. 同一字段的 challenge 来回计入 rounds，上限沿用 `returnTo.maxRounds`。

### D.6 提问（question）

agent 可以向某个字段的归属节点提问。对方不重跑任务，只在其原会话中做一次“答疑回合”：程序加载对方的会话，追加 `有同事提问：<body>。请调用 board_post 以 answer 回复，然后调用 submit_answer 结束本回合。`。答疑回合预算固定为 8000 token、3 分钟。

每件货、每个被问节点最多 2 次答疑。超过后，提问工具返回错误：`本节点答疑次数已用完，请依据现有证据判断`。

提问方在调用 `board_post(question)` 后会等待答复：其节点进入 `waiting(room)`，答复写入后自动恢复会话，答复内容作为工具结果返回。

### D.7 讨论室

**何时开**（只有这三种情况）：

1. 策展线 `kind-join` 结果为 `disagree`（替代原来直接交给 arbiter）；
2. D.5 第 2 条 b：归属节点反驳了 challenge；
3. 主调度通过工具 `open_room` 开（阶段 F）。

**参与者和裁判**（按字段，写在 pack 里，新增字段 `rooms`）：

| field | participants | judge | 各自看什么（view） |
|---|---|---|---|
| `kind` | classify, classify-review | arbiter | classify 只看 dossier 文本；classify-review 看 dossier 加首页截图 |
| `shots.*` | shot-review, style, reader | program:shot-rules（现有 `curation.process` 的规则检查函数）→ 程序判不了时交给 shot-review | shot-review 看截图和程序像素统计；style 看截图；reader 看页面计划与 sitemap |
| `style` | style, shot-review | program:style-veto（现有风格否决规则）→ 程序判不了时交给 style | 同上 |
| `facts.*` | facts, fact-review | fact-review | facts 看来源页；fact-review 看来源原文摘录 |
| `copy` | copy, copy-review | copy-review | 两者都看 facts 和 style |

参与者的模型绑定可以单独设置（沿用现有节点绑定）。pack 可以为每位参与者另指定模型，以增加差异；没有指定时用节点默认模型。

**怎么开会**：

```
room.round = 1
loop:
  for p in participants（固定顺序）:
     在 p 的原会话（没有就新开）追加：
       "讨论室 <topic>，第 <round>/<max> 轮。下面是本室全部发言。请只围绕字段 <field>，
        发表一条 board_post（type 为 claim、challenge 或 answer），给出证据 id，然后调用 submit_turn。"
       + 本室所有发言（board_posts where room = id）
     p 必须恰好发一条 post 后 submit_turn；本回合预算 12000 token / 4 分钟
  一轮结束，程序判定：
     若所有参与者在本轮的最新 claim 对该字段的取值完全相等（JSON 深度相等）→ status='resolved'，
       采用该值写入 data，下游按 B.7 从该字段归属节点之后重跑
     否则 round++；若 round > max_rounds → 交裁判
裁判：
  程序裁判：调用对应规则函数，返回明确结论即采用
  agent 裁判：在裁判会话中给出全部发言，要求 submit {value, quote, evidence}；
     quote 必须是参与者证据中的逐字原文（程序校验子串存在）
  裁判也无法给出 → 货 parked，code='room_unresolved'，进入主调度队列
```

讨论室进行期间，该字段的下游节点保持 `pending`，不受影响的其他分支照常推进。

### D.8 跨货经验板

复用 `server/lessons.ts` 的存储。新增：agent 节点开工时，在系统提示末尾附上与该节点相关、状态为“生效”的经验，最多 5 条，每条 ≤ 300 字，按最近生效时间倒序。经验由主调度写入（阶段 F），用户可在 UI 中删除。

### D.9 测试（新建 `test/board.test.ts`）

1. 节点完成后自动发 claim，同字段旧 claim 变为 superseded。
2. 旧式 fix 自动转换为 challenge，退回到正确节点，续接会话中包含 challenge 原文。
3. 归属节点反驳 → 开讨论室 → 第 2 轮取值一致 → resolved，下游重跑。
4. 3 轮不一致 → agent 裁判；裁判 quote 不是原文子串 → 拒绝，重新要求；第二次仍然不合格 → parked。
5. 答疑次数用完后，工具返回规定的错误文本。

### D.10 验收

在阶段 B 的 30 站运行记录中（阶段 D 完成后重跑 10 站即可），至少出现：3 次 challenge → 改正 → resolved，1 次讨论室（任意字段）走完。在进度文件中逐条贴出 board_posts（截断到 200 字）。

---

## 阶段 E · 三条消息流（UI）

> 说明：`ui/` 由 Claude 负责（AGENTS.md 分工）。**Codex 只做 E.1 的 `shared/streams.ts` 纯函数，以及 E.2/E.3 所需的后端统计接口（items 表计数、attention 列表），不改 `ui/` 下任何文件。** E.2–E.4 的界面部分由 Claude 实现。

### E.1 分流规则（写成纯函数 `shared/streams.ts: streamOf(event): 'progress'|'conversation'|'attention'|'none'`）

| 流 | 事件 |
|---|---|
| progress | `attempt.started/progress/activity/finished`、`token.queued/data/created`、`evidence.added`、`resource.sample` |
| conversation | `board.posted`（type ≠ claim）、`room.*`、`chat.*`、主调度复盘摘要（阶段 F） |
| attention | 货 parked 且 code ∈ {auth, tls, http_forbidden, EXTERNAL_OPERATION_UNKNOWN, room_unresolved, manual_store}；waiting(budget) 超过 10 分钟未被主调度处理；登录/验证提醒（`alert.raised`）；需要用户批准的补丁 |
| none | 其余 |

claim 不进对话流，只在“货的证据链”视图中显示。

### E.2 右侧栏

1. 顶部固定一行总结：`在跑 N · 等资源 M · 等模型 K · 已发布 P · 需要你 Q`，数字来自 items 表统计。
2. 总结行下方是注意卡片：attention 流中最新的 5 条，每条一行：货名、原因、一个按钮（“查看”或“处理”）。处理完后自动消失。
3. 群组列表：一个“主调度”群组，加上 D.7 表格中每个 field 的一个群组（分类、三屏、风格、事实、文案）。群组内只显示 conversation 流，保留现有 Grok Bot 式行样式（小人 + 名字 + 时间 + 状态）。
4. 进展默认隐藏；群组顶部有开关“显示进展”，默认关闭，状态存在 localStorage。
5. v2 下隐藏“10 件实测 · 配员待确认”按钮以及所有工人数调整控件。

### E.3 画布

节点上的计数改为由 `stationNumbers` 提供：ready / running / waiting（按原因分颜色：model 黄、budget 橙、room 紫、backoff 灰）/ 本轮 done / parked。其他画布样式不改。

### E.4 验收

截图存到 `docs/v2-acceptance/E/`：①右侧总结行加注意卡片；②三屏群组中一次 challenge 往来；③进展开关打开和关闭的对比；④画布节点的 waiting 着色。同时 `npx tsc -p ui/tsconfig.json`、`npm run build` 通过。

---

## 阶段 F · 主调度复盘（G5）

### F.1 触发

满足以下任一条件就开始一次复盘（同一时刻最多一个复盘在跑）：

- 自上次复盘起，运行时间累计满 30 分钟；
- 自上次复盘起，终结的货达到 20 件；
- 10 分钟内新增 parked ≥ 5 件。

### F.2 输入包（程序生成，总长 ≤ 60000 字符；超出时按以下顺序截断：样本 → 簇 → 指标）

```ts
interface ReviewBundle {
  window: {from: number; to: number};
  nodes: Array<{node: string; attempts: number; ok: number; failedByTag: Record<string, number>;
    p50Ms: number; p90Ms: number; p50Tokens: number; p90Tokens: number;
    returnsByReason: Array<{reason: string; count: number}>;   // reason 取前 80 字归一化
    handoffs: number}>;
  clusters: Array<{node: string; tag: string; message: string; count: number;
    samples: Array<{attempt: string; item: string; excerpt: string}>}>;   // 前 5 簇；每簇 2 个样本；excerpt = 最后 3 条 assistant 消息 + 工具错误，≤ 3000 字
  parked: Array<{item: string; node: string; code: string; reason: string; since: number}>;
  waitingBudget: Array<{item: string; node: string; handoff: unknown}>;
  patches: Array<{id: string; type: string; node?: string; status: string; canary?: CanaryResult}>;
}
```

聚类规则：键为 `node + tag + message 前 80 字`（去掉数字、URL、哈希后的结果）。

### F.3 主调度会话与工具

使用现有主调度的模型绑定（`agent.defaults.dispatcher`），每次复盘开一个新会话（不复用聊天会话），预算 80000 token / 10 分钟，结束方式遵守阶段 C 的规则。

工具（只有这些）：

```ts
read_attempt({id}): AttemptDetail            // 现有接口复用
read_item({id}): ItemSummary
read_board({item}): BoardPost[]
resolve_parked({item; action: 'retry' | 'retry_with_note' | 'exclude' | 'leave_for_user'; note?: string})
extend_budget({item; node; factor: 1.5 | 2})  // 每个节点每件货只能用一次
open_room({item; field; topic})
write_lesson({node; text; evidence: string[]}) // text ≤ 300 字；evidence 必须是真实 attempt id
propose_patch(Patch)
submit({summary: string})                     // ≤ 500 字，给站长看的复盘结论
```

`resolve_parked` 的 retry：节点 attempts 清零，rounds 保留，`redo.note = note`。`exclude` 只允许用于 code 为 `room_unresolved` 或 `retries_exhausted` 的货；其余情况必须用 `leave_for_user`。

### F.4 补丁白名单

```ts
type Patch =
  | {type: 'role_addendum'; node: string; text: string}                   // ≤ 1500 字，附加在该节点 ROLE 正文之后
  | {type: 'retry_policy'; node: string; maxRetries: number; initialMs: number}  // maxRetries 0–5
  | {type: 'budget'; node: string; maxTokens?: number; maxMs?: number}    // 默认值的 0.5×–3×
  | {type: 'param'; name: string; value: number}                          // 只允许 pack 声明在 tunableParams 的参数
  | {type: 'model_binding'; node: string; binding: StationAgentBinding};  // 必须是已配置的模型
```

**任何其他改动一律拒绝**，包括：accept、闸门、schema、校验器、规则引用、节点与边、`maxRounds`。被拒绝时，工具返回错误原因，主调度可以重新提案。

pack 新增 `tunableParams`。策展线首批只声明以下参数（由执行器读取；默认值等于现有代码中的常量，必须先找到对应常量再声明）：

- `proof.candidateLimit`：特写候选页数，默认取现有值；
- `scout.keyPageLimit`：侦察关键页数，默认取现有值。

找不到对应常量时，不声明这个参数，并记入 decisions。

### F.5 金丝雀

- 补丁创建后状态为 `canary`。之后新入场的货中，`hash(itemId + patchId) % 5 === 0` 的（即 20%）应用补丁，记为 `item.canary = patchId`；其余货为对照组。
- 同时最多 2 个 canary 补丁，且不能作用于同一个节点。
- 金丝雀组满 15 件终结，或已过 2 小时（以先到者为准），由程序比较：
  - 该节点成功率：canary − control ≥ −5 个百分点；
  - 下游闸门通过率：canary − control ≥ −5 个百分点；
  - 并且以下至少一项改善 ≥ 10%：退回次数、p50 token、p50 耗时、parked 率。
  - 全部满足 → `promoted`（对所有新货生效）；否则 → `rolledback`。
- 金丝雀组不足 5 件就到 2 小时 → `rolledback`，原因写“样本不足”。
- `model_binding` 补丁**不能自动推广**：比较结果出来后进入注意流，由站长点击批准。
- 所有状态变化写入 journal：`patch.proposed/canary/promoted/rolledback/reverted`。站长可以在 UI 中撤销任何已推广的补丁（`reverted`）。

### F.6 经验

`write_lesson` 写入的经验，状态为 `canary`，与补丁一样按 20% 金丝雀生效。比较规则同 F.5，只看该节点成功率与退回次数。

### F.7 复盘结果展示

复盘的 `submit.summary` 进入对话流的“主调度”群组。补丁和经验的状态变化各发一行。

### F.8 测试（新建 `test/supervisor.test.ts`）

1. 输入包长度不超过上限，截断顺序正确。
2. 白名单外的补丁被拒绝，返回原因。
3. 金丝雀分流的确定性：同一个 itemId 多次计算结果相同。
4. 推广和回滚判定：分别构造满足和不满足条件的统计数据。
5. `model_binding` 补丁不会自动推广。

### F.9 验收

在项目副本上用真实模型连续运行 ≥ 2 小时（≥ 40 站），至少完成 2 次复盘，至少 1 个补丁走完金丝雀（推广或回滚都算）。把复盘摘要、补丁和比较数据贴进进度文件。

---

## 附录 1 · 最终交付清单

- [ ] `docs/v2-progress.md`：每个阶段的命令、数字和结论
- [ ] `docs/v2-decisions.md`：所有自行做出的选择
- [ ] `docs/v2-acceptance/`：B 的状态记录、E 的截图、F 的复盘记录
- [ ] 每阶段都跑过：`npm test`、`npm run typecheck`、`npx tsc -p ui/tsconfig.json`、`npm run build`、`npm run desktop:smoke`
- [ ] 默认内核切换为 v2：阶段 B 验收全部通过后，在进度文件写“请求切换默认内核”并停下；站长确认后才改默认值，同一提交只改默认值这一处
- [ ] v1 代码保持可运行（`FACTORY_KERNEL=v1` 时全部现有测试通过）

## 附录 2 · 术语

| 词 | 含义 |
|---|---|
| 货 / item | 一件在一条线上流动的任务，v1 叫 token |
| 节点 / node | 线上的一个工位，key 为 `line/station` |
| parked | 货停下，等主调度或站长处理；必须带 code 和 reason |
| waiting | 节点暂时不能执行，带原因（backoff/model/resource/budget/room/supervisor），条件满足后自动恢复 |
| 黑板 | 每件货一份的结构化发言记录（board_posts） |
| 讨论室 | 针对某个字段的分歧，限定参与者和轮数的会话 |
| 金丝雀 | 补丁只对 20% 新货生效，比较后再决定是否推广 |
