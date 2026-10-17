# 组件入库：真实项目里的现状与待改（2026-10-17）

本轮只读检查了本地真实项目 `Documents/Easy Workflow/Projects/curation-five-sites-20261010-r2`
的 `journal.db`（4259 条事件，末次运行 `run-202610110825-ca06`）与 `published/`，
没有启动桌面程序、没有启动入库后台。所有结论都能按事件序号复核。

## 1. 实测事实

| 事实 | 证据 |
|---|---|
| 本轮跑过 5 个站：magicui.design、carbondesignsystem.com、lucide.dev、lawsofux.com、uiverse.io | `token.created` |
| 判定结果：magicui=`component-source`、carbon=`design-system`、lucide=`assets`；lawsofux 没拿到 kind；uiverse 停在 `candidates/tidy` | `token.data.kind` / `token.finished` |
| 已发布 3 个站：carbondesignsystem.com、lucide.dev、magicui.design（`curation/published`=214） | `published/*.json` |
| 整卷日志里 `channel.emitted` 只有 1 条（seq 618，magicui.design），**`channel.delivery` 一条都没有** | 事件种类统计 |
| `components/inbox` 库存停在 1；`components/*` 的 attempt 与 token 都是 0 | `stock.set` / `attempt.started` / `token.created` |

结论：组件入库确实被“识别即排队”触发了（magicui 在 `curation/kind-join` 确认后发射信道事件），但那次投递
**没有落成 `channel.delivery`，也就没变成任何工位工作**。组件线在这个项目里一次都没有真正跑过，
所以三个站都还是“未组件入库”。

## 2. 复核

把该 journal 复制到临时目录，用当前 `ChannelSupervisor` 重放同样的
`token.data / channel.emitted / channel.delivery` 事件（runtime 用桩替换，不动真实项目）：

- 收到 seq 618 的 emission（注意：该事件没有 `inventory` 字段，是旧版发射器写的）；
- `receive(618)` 现在会追加一条 `channel.delivery`：`target=components/inbox`、`status=pending`、`item=magicui.design`；
- 旧版那时没有落这条投递，属于当时版本的行为，现版本重放已能补上。

也就是说：这个项目下次启动时，magicui 的组件投递会作为 pending 出现；但它要等到
本轮在跑（未暂停）才会被领取成子任务。

## 3. 要改的（按优先级）

1. **投递不可见。** 跨线投递的状态此前没有任何控制面入口，卡住的交接只能靠翻日志发现。
   本轮已加 `channels` 能力：`channels({action:"state"})` 列出未完成投递（目标、
   状态、尝试次数、原因），`channels({action:"retry",id})` 重新排队。属于只读的那一半不写日志。
2. **同步口径要明确。** 现在只有 `kind=component-source && kindAgreed` 才排队组件
   （`runtime.emitChannel` 里的硬编码分支，对应 VisLexicon Spec §4.0）。三个已发布站里
   carbon 被判成 `design-system`、lucide 被判成 `assets`，因此永远不会排队。
   按 Spec §2.4，同时提供“规范和可安装组件”的站应判 `component-source`（或拆成两条）——
   这是策展判定该修的地方，不是组件线该放宽的地方。**需要站长定：是修分类口径，还是把
   `design-system` 也纳入组件排队。** 不擅自改数据语义。
3. **组件线自己判 URL 的步骤没有用上 Kev-9B。** `components/discover` 目前只用
   `componentLinks` 的正则和同源判断；VisLexicon 实测的 ③ Jev 分类（20 条/请求、约 1.2 秒）
   正是省时间的那一步。`server/decision-model.ts` 与 `packs/vislexicon/decisions.ts`
   已有现成的 `chooseSourceLinks` 模式可以复用，失败必须回退到“保留全部候选”。

## 4. 已做的配置

`~/.pi/agent/easy-workflow/decision-model.json` 的 `projects` 之前只有
`Pi Factory/Projects/vislexicon-curation` 和 `H2/var`，**没有**正在跑的项目目录，
所以 Kev-9B（Jev）在这个项目里根本没启用。已加入
`C:/Users/zjz65/Documents/Easy Workflow/Projects/curation-five-sites-20261010-r2`
（文件其余内容不变，key 未动、未打印）。

## 5. 本轮没做的

三个站的组件入库真实运行没有执行：需要启动入库后台（服务、浏览器、模型调用），
与“不要在我本地启动软件和启动入库的后台”冲突。等站长放开这一条，或在隔离项目里跑。
