# 任务：批量网站入库评测（VisLexicon Bench v1）

你收到这份文件后，**直接开始工作，不要等我补充说明，也不要中途问我问题**。遇到不确定的情况，按本文规则自行决定，并把决定写进结果。整个过程中没有人会回答你。

你的任务：像一个多 Agent 团队一样，把下面 22 个网址逐个“入库”。对每个网址，判断它是哪一类设计资源，截三张证据图，标风格，核对事实，写中文简介。最后按 §6 的格式输出结果。

可以使用你拥有的全部能力：浏览器、搜索、子 Agent、并行、代码执行。怎么分工、怎么并行由你自己决定，但要在结果里如实报告（§6.2）。

---

## 1. 网址清单

| id | 网址 |
|---|---|
| s01 | https://ui.shadcn.com |
| s02 | https://ui.aceternity.com |
| s03 | https://bencho.dev |
| s04 | https://semi.design |
| s05 | https://m3.material.io |
| s06 | https://carbondesignsystem.com |
| s07 | https://lucide.dev |
| s08 | https://fonts.google.com |
| s09 | https://themeforest.net |
| s10 | https://component.gallery |
| s11 | https://godly.website |
| s12 | https://dribbble.com |
| s13 | https://gsap.com |
| s14 | https://spline.design |
| s15 | https://photoswipe.com |
| s16 | https://tailwindcss.com/docs |
| s17 | https://www.joshwcomeau.com |
| s18 | https://www.refactoringui.com |
| s19 | https://linear.app |
| s20 | https://careers.kimi.com |
| s21 | https://ui.shadcn.com/docs/components |
| s22 | https://example.com/this-page-does-not-exist-vislexicon |

---

## 2. 第一步：去重与可达性

- 两个网址如果指向**同一个用途的同一个站**（同一域名，且后一个只是前一个站内的某个子页面），后一个记为 `duplicate`，并在 `duplicateOf` 写前一个的 id。它不再做后续步骤。
- 打不开、返回 404/410、或者没有实际内容的网址，记为 `unreachable`，写明原因（HTTP 状态码或错误信息）。它不再做后续步骤。
- 其余记为 `ok`，继续下面的步骤。

## 3. 第二步：分类（七类，只选一个主类）

**只问一个问题：一个人打开它，最后拿走的是什么？** 严格按下表从上往下逐条问，**第一个回答“是”就停**：

| 顺序 | kind | 判定问题 |
|---|---|---|
| 1 | `gallery` 灵感合集 | 它主要是把别的网站或作品收集在一起，供你浏览吗？ |
| 2 | `component-source` 组件源 | 它让你直接复制或安装现成的界面组件、区块吗？ |
| 3 | `design-system` 设计规范 | 它是某个团队公开的设计规则与 token 文档吗？ |
| 4 | `assets` 素材与模板 | 它提供可以下载的字体、图标、图片、3D、模板文件吗？ |
| 5 | `tool` 工具与库 | 它是你用来生成、编辑东西的工具或代码库吗？ |
| 6 | `knowledge` 知识 | 它主要是文章、教程、课程或书吗？ |
| 7 | `work` 作品 | 以上都不是：它本身就是一个值得看的设计（官网、作品集等） |

补充规则：
- 一个站同时提供设计规范和可安装的组件时，主类选 `component-source`，并在 `alsoKinds` 里写 `design-system`。
- 给出判定依据：`kindQuote` 必须是从该网站页面上**逐字复制**的一句原文（中英文都可以，≤ 200 字符），并附上这句话所在页面的 `kindQuoteUrl`。

## 4. 第三步：三张证据图

每个 `ok` 站截三张图（视口宽 1440、高 900，PNG 或 WebP）：

| 角色 | 截什么 |
|---|---|
| `identity` 首屏 | 首页首屏 |
| `breadth` 目录 | 能看出“里面有什么”的目录、列表或网格页（如 /components、/docs、作品列表、素材网格） |
| `proof` 特写 | 一个具体内容的特写：组件源 = 一个组件的预览区（只截预览，不截文档文字）；设计规范 = 一个组件示例或色彩页；素材 = 单个素材详情；工具 = 工具实际产出东西的页面（playground/demo，**不截**定价、登录、下载页）；知识 = 一篇文章的正文首图或首个 demo；合集 = 一个被收录作品的详情页；作品 = 页面向下滚动后、与首屏差异最大的一屏 |

截图规则：
- **永远不登录、不注册、不填表**。遇到 Cookie 弹窗，只点“拒绝”或“仅必要”；没有拒绝按钮时，不要点“接受”，在截图前把它隐藏（或换一页截）。
- 截图必须用浅色模式，除非这个站在无偏好设置下默认就是深色。把实际使用的配色写进 `colorScheme`。
- 以下情况不合格，需要换页重截：空白页、大块单色、登录墙、人机验证、弹层盖住超过 25% 的页面、404 页。
- 三张图必须来自三个**不同**页面（作品类例外：可以是同一页的不同滚动位置）。
- 实在截不到时，那一张写 `null`，并在 `shotNotes` 里说明原因。

## 5. 第四步：风格、事实与简介

### 5.1 风格（只给 kind 为 component-source / design-system / assets / work 的站打；其余 kind 写 `[]`）

只能从下面 22 个词里选，**最多 3 个**，按主次排序：

`minimal` 极简留白 · `apple-like` 苹果式精致 · `glass` 毛玻璃 · `soft-3d` 软拟物 · `brutal` 粗野直给 · `terminal` 终端字符 · `pixel` 像素 · `editorial` 杂志排版 · `swiss` 瑞士网格 · `dark-neon` 暗底霓虹 · `gradient-mesh` 弥散渐变 · `bento` 便当格 · `hand-drawn` 手绘 · `clay` 黏土 3D · `retro` 复古 · `y2k` 千禧镭射 · `playful` 活泼卡通 · `corporate` 规整商务 · `material` Material 风 · `skeuomorphic` 拟物 · `motion-heavy` 动效驱动 · `monochrome` 黑白单色

规则：
- 组件源和设计规范：看**组件本身**的样子，不看网站的导航、公告条或营销首屏。
- 素材：看素材本身。作品：看页面本身。
- 一个风格词至少要在两张证据图里都能看到；每个词要写出依据（在哪张图、看到了什么，≤ 30 字）。
- 互斥的词不能同时选：`minimal` 与 `brutal`，`monochrome` 与 `dark-neon`。
- 看不清、拿不准时写 `[]`，并在 `styleNotes` 里说明原因，不要猜。

### 5.2 事实（每一项都要有出处；查不到就写 `"unknown"`，不要猜）

| 字段 | 取值 |
|---|---|
| `free` | `"yes"` / `"freemium"` / `"no"` / `"unknown"` |
| `openSource` | `"yes"` / `"no"` / `"unknown"`（源码公开并带开源许可才算 yes） |
| `license` | 许可名称，如 `"MIT"`、`"Apache-2.0"`、`"OFL"`，或 `"unknown"` |
| `commercialUse` | `"yes"` / `"no"` / `"conditional"` / `"unknown"` |

每个非 unknown 的值都要附 `source`（具体页面 URL，例如 LICENSE 文件、定价页、FAQ）和 `quote`（从该页面逐字复制的原文，≤ 200 字符）。

### 5.3 中文简介

- `descriptionZh`：60–120 个汉字，说清楚三件事：谁做的、能拿走什么、规模大概多大。
- 只写有出处的事实；数字必须能在页面上找到。不要写形容词堆砌和营销腔。
- `takeawayZh`：一句话（≤ 20 字），说“打开它你拿走什么”。

---

## 6. 输出格式（严格遵守）

### 6.1 结果文件：`vislexicon-bench-result.json`

能写文件就保存成文件，并告诉我文件位置；不能写文件，就在对话里输出一个完整的 ```json 代码块。如果你能保存截图，就把截图放进 `shots/<id>/<role>.png` 文件夹，并在 JSON 里写相对路径；不能保存，就写截图所在页面的 URL。

```json
{
  "bench": "vislexicon-bench-v1",
  "agent": {"product": "你的产品名", "model": "底层模型名（知道的话）", "version": "版本（知道的话）"},
  "startedAt": "ISO 时间",
  "finishedAt": "ISO 时间",
  "sites": [
    {
      "id": "s01",
      "url": "原始网址",
      "status": "ok | duplicate | unreachable",
      "duplicateOf": null,
      "unreachableReason": null,
      "kind": "component-source",
      "alsoKinds": [],
      "kindQuote": "逐字原文",
      "kindQuoteUrl": "https://...",
      "shots": {
        "identity": {"page": "https://...", "file": "shots/s01/identity.png"},
        "breadth":  {"page": "https://...", "file": "shots/s01/breadth.png"},
        "proof":    {"page": "https://...", "file": "shots/s01/proof.png"}
      },
      "colorScheme": "light | dark",
      "shotNotes": "",
      "styles": [{"id": "minimal", "basis": "identity+proof：大面积留白、细描边"}],
      "styleNotes": "",
      "facts": {
        "free":          {"value": "yes", "source": "https://...", "quote": "..."},
        "openSource":    {"value": "yes", "source": "https://...", "quote": "..."},
        "license":       {"value": "MIT", "source": "https://...", "quote": "..."},
        "commercialUse": {"value": "yes", "source": "https://...", "quote": "..."}
      },
      "descriptionZh": "……",
      "takeawayZh": "……",
      "confidence": 0.8,
      "secondsSpent": 95,
      "retries": 0,
      "problems": []
    }
  ]
}
```

所有 22 个 id 都必须出现在 `sites` 里，即使没完成；没完成的写 `"status": "ok"`、未完成的字段写 `null`，并在 `problems` 里说明。

### 6.2 过程报告：`vislexicon-bench-run.md`

如实填写，不知道的写“未知”：

```markdown
# Run report
- 总耗时（墙钟）：
- 是否使用多个 Agent / 子任务：是/否；如果是，有几个、各自负责什么：
- 是否并行；最大同时处理几个网址：
- 总 token 用量（知道的话）：
- 总工具调用次数（大概）：
- 中途是否需要人类介入：（应为“否”；如果卡住了，写卡在哪里）
- 失败与重试：逐条列出（网址 id、失败原因、怎么处理的）
- Agent 之间是否互相检查或纠错：举 1–3 个具体例子（谁质疑了谁、改了什么）
- 自我评估：哪些结果你最没把握，为什么
```

---

## 7. 时间上限

总共最多 90 分钟。到时间就停下，输出已完成的部分，没完成的按 §6.1 的要求标注。**不要因为某一个网址卡住而影响其他网址。**

现在开始。
