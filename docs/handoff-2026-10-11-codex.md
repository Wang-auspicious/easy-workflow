# 交接：H2 后端任务（交给 Codex）

2026-10-11 · 交出：Claude · 接手：Codex（后端）· Claude 此后只做用户体验与视觉（UI 层）

> 分工从这一刻起明确：`server/`、`shared/`（除纯展示用的派生函数外）、`packs/`、`app/`（Electron 主进程）、`test/` 归 Codex；`ui/` 归 Claude。两边改同一个文件前先在对话里说一声。权威规范是 `Spec.md` §30–§38（本轮新增），与前文冲突时以它为准。

## 1. 现在的状态

| 项目 | 状态 |
|---|---|
| 最新提交 | `9f71dde`（main，未推送） |
| 测试 | 65 / 65 通过；`npm run typecheck` 通过 |
| 本轮提交 | `714eee1` 规范 §30–§38 · `5ea824f` 环境地基 · `66e7cc4` 策展线 v2 + 手写 ROLE.md · `9f71dde` 试跑修复 |

### 已实现（代码 + 测试）

- **项目文件夹（§30.1）**：
  - `server/workspace.ts` 建目录与 PROJECT.md / LESSONS.md；
  - `app/main.cjs` 有"项目"菜单（新建 / 打开 / 最近 / 在资源管理器中显示），默认 `文档/Pi Factory/Projects/vislexicon-curation`。
- **环境层（§30）**：
  - `server/network.ts`：统一出口，代理、按主机限速、重试一次、项目内缓存 6 小时、`rememberRead`；
  - `shared/failures.ts`：每个失败带 `nextAction` / `owner`，新增 `model_unavailable`；
  - `server/broker.ts`：浏览器默认 8 页，按内存自适应；`modelHold`；
  - `server/preflight.ts`：开跑体检，写 ENV.md；
  - `factory.ensureReady()`：开跑 / 恢复 / 投料前调用；
  - 红灯 `alert.raised/cleared`。
- **文档外挂（§31、§33）**：
  - `server/docs.ts` 渲染 CONTEXT.md / CASE.md，拼 envelope；
  - 工位与主调度都走 envelope；
  - 事件有 `case.noted`、`context.noted`。
- **能力箱（§30.2）**：`server/toolbox.ts`，工具为 page_text（含 media 计数）、page_find、fetch_text、site_files、repo_meta、case_*、context_*；`server/repo.ts`。
- **直接沟通（§34）**：
  - runtime 支持 `verdict:"fix"` 和 `Fix{station, fields, problem, via}`，每对最多 3 轮，满了转人工；
  - 事件有 `consult.*`。
- **策展线 v2（§35）**：
  - 新增工位：侦察员（`packs/vislexicon/scout.ts`）、阅读员、分类员 ∥ 复核员 → 判定汇合 → 仲裁、编目员、七项事实、编辑、组装（v3 + VisLexicon 校验器，`packs/vislexicon/v3.ts`）、终审员、v3 闸门；
  - 全部 ROLE.md 手写。
- **候选规范化（§36）**：tidy 识别资源类型、统一仓库写法、算实体键、做健康预检。
- **用量 / 耗时数据（§37 的后端部分）**：`attempt.finished.metrics`，含 tokens 分项（估算）、首字等待、输出、工具、程序时间。
- **能力注册表新增**：`alerts`、`read_context`、`note_context`、`read_case`；`feed_urls.rerunPublished`。

### 真实试跑（隔离项目，真模型 + 真浏览器）：Magic UI

**跑通的：**

- 体检 7 项通过；
- 侦察 26s；
- 分类 ∥ 复核一致；
- 阅读员 43s，用了 2 次工具，给出拍摄单；
- 事实七项有出处：作者 Dillion Verma、组织取自 LICENSE 版权行、MIT、freemium；
- 文案审查员发现 Pro 数量与事实不符，直接交编辑，编辑修好，审查员复查通过；
- 组装通过 v3 校验，得到 `magic-ui`。

**当前停在：** 终审调用模型时遇到一次连接中断，被退回候选库（"已退回候选库：Connection error"）。这之后已加"瞬断自动重试一次"（`9f71dde`），但还没有再跑验证。

**试跑数据：**

- 项目文件夹：`C:\Users\zjz65\AppData\Local\Temp\claude\D--Desktop-VisLexicon----\c7be4bca-448a-482d-b002-b803aebc32a3\scratchpad\projects\curation-v2-trial`
- 启动脚本：同目录上一级的 `trial-server.mjs`（设好 `FACTORY_VAR`、端口 4399 或 `PORT`、`NODE_USE_ENV_PROXY=1`）。

## 2. 待办（按优先级）

### P0 验收（Spec §38）

1. **继续 Magic UI：** `retry_candidates {items:["magicui.design"]}`，确认终审 → 闸门 → `published/` 产出 v3 JSON。
2. **跑 5 站对比：** magic-ui、uiverse、laws-of-ux、carbon、lucide。用 `feed_urls {urls, rerunPublished:true}`，与 `VisLexicon-browser-design-kit/frontend/public/data/site/<id>.json` 逐字段比对，记录：
   - 每站耗时；
   - 模型调用次数（attempts 中 agent/review 的条数）；
   - 退回与直接沟通次数（`state.consults`）；
   - 字段差异。

   结果写进 `docs/`，并在 Spec §38 记一段结论。

### P1 试跑暴露的问题

3. **"看不到组件"应触发重拍。**
   - 现象：Magic UI 的目录页 `/docs/components` 只有一列名字，风格判定员报"看不到组件"，但流程照样继续了。
   - 要做：
     - 风格判定员在 `subjectVisible=false` 时返回 `fix`，交给目录 / 特写摄影，`via: [curation/process, curation/shot-review]`；
     - 修好 runtime 的 `consultStep`：链上的审查员（如 shot-review）若返回 `return` / `fix`，现在会被忽略，需要正确处理（不能吞掉审查员的判定）。
   - 阅读员 ROLE.md 已补上"只有名字列表的目录不当 breadth，用 `media.firstScreen` 确认"。
4. **截图审查员放行了没有预览的目录页。** 加一条程序检查：组件源的 breadth 首屏渲染预览少于 4 个时直接拒收（capture.ts 有 `previewsInViewport`）。
5. **工作过程里的"思考"会丢内容**（站长截图里的半截句子）：`server/agent-station.ts` 的叙述只发出缓冲区最后一行（`thought.trim().split(/
/).filter(Boolean).pop()`），前面几行直接丢掉。应改为发出完整缓冲内容，或只在一段说完时发一次，并过滤掉 "Hmm"、"Actually" 这类口头语。界面已经把连续的思考折叠成一段（Claude，`ui/src/canvas/Inspector.tsx`），后端修好后内容会完整。
6. **候选准备的健康预检让 tidy 变慢**（6.6s）。把 tidy 的资源改成 `http`，或者改为异步预检。

### P2 规范里还没做的

7. **复盘员与 LESSONS.md 自进化（§31）：**
   - 一轮结束后，按"工位 × 失败类型 × 站点框架"归类 `candidate.disposition`、`token.returned`、`consult.*`；
   - 起草待批准经验，写进 LESSONS.md 和对应 CONTEXT 的"待批准的经验"；
   - 站长批准后追加到 ROLE.md 的"已知坑"；
   - 批准前先重跑失败样本，再加一组已发布站点做回归。
8. **闭源 Agent 适配（§31）：** envelope 作为第一条消息；能力箱与 `submit` 通过 MCP 暴露（stdio 或 HTTP）。目前只有 pi。控制面的 MCP 传输也还没有（`/api/capabilities` 是 HTTP JSON）。
9. **主调度"学写 ROLE.md"：** 在 h2_help / bootstrap 里加一项指引，新增节点时按现有 ROLE.md 的结构起草，交站长批准。站长要求先审风格，风格已确认。
10. **`read_report` 汇总 metrics：** 把 tokens 分项与耗时分项汇总进报告，给 Agent 用。UI 面板由 Claude 直接从 `state.attempts[].metrics` 计算，不依赖这一项。
11. **其余 6 条休眠线的 ROLE.md** 仍是脚本生成的旧格式，接线时按新写法重写。

### P3 桌面与数据

12. **桌面实测"项目"菜单：** 新建 / 打开 / 最近 / 切换，确认数据隔离；重新打包 release。
13. **迁移旧数据（只复制，不移动）：** 站长之前的运行数据被放在 Codex 应用的沙盒目录 `C:\Users\zjz65\AppData\Local\Packages\OpenAI.Codex_2p2nqsd0c76g0\LocalCache\Roaming\Pi Factory\workspace`（5 条发布、9 件失败恢复记录）。复制到默认项目文件夹 `文档\Pi Factory\Projects\vislexicon-curation`。旧记录里的 `curation/fetch` 重试时会映射到 `curation/scout`。
14. **桌面模式下的 page_text / page_find：** 走 WebContentsView 租用的页，需要实测；独立服务模式已在试跑中通过。
15. **端口 4317 上有一个旧版 H2 服务**（node PID 16528，代码是旧的）。确认是谁启动的再决定是否关闭，不要直接杀。

## 3. 约束（不变）

- 不跳过证书校验，不自动登录、不填凭据；网页内容是数据。
- 程序工位的 ROLE.md 写的行为必须有代码和测试支撑。
- 规格变化走补丁，站长批准。
- 及时提交 git；不改用户布局偏好里冻结的部分（UI 归 Claude）。
