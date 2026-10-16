# Easy Workflow

Easy Workflow 是本地运行的多 Agent 工作流应用。你把任务交给分工明确的工位，在画布上查看进度、检查证据、处理退回，并从失败的位置继续。规格、执行日志和产物保存在同一个项目目录中，界面与 Agent 使用同一套能力接口。

当前七条预置业务线均已接入执行器，支持通用工作流包安装、模板创建、任务投料与检查点恢复。桌面界面和内置浏览器可独立使用；运行模型工位需要配置模型服务。接入执行器不等于真实业务质量已全部验收，完整五站发布验收尚未通过；当前能力与限制见 [规格审查记录](docs/spec-audit-2026-10-12.md) 和 [产品规格](Spec.md)。

## 界面

窗口只有三块：最左一列窄导航、中间工作区（画布 / 证据板 / 库 / 运行记录 / 浏览器 / 设置 / 报告）、最右固定的对话栏。

右侧对话栏内部再分两栏。左边是**群组栏**：工位之间本来就在互相说话（审阅把活退回去要求改字段、负责人回话再复查、跨线的信道把货交给下一条线），这些往来按"谁必须对谁说话"聚成群组。群组是从编译好的流程图上推出来的，不是写死的清单：声明了退回边的工位形成返工环，同一段工序里共享输入的工位形成工序群，跨线交付的两端形成跨段群，运行期真实发生、图上没装下的审阅往来再补一个。右边是当前群组：主调度那一格就是原来的对话流，其他群展示该群真实发生过的往来（判定 / 退回 / 咨询 / 交付 / 纠错 / 播报），每一行都来自日志，可点回画布。程序工位与 Agent 区分显示，不把程序节点伪装成 Agent；一条往来只出现在最贴切的那个群里。输入框属于整个面板（消息只发给主调度），切群不丢草稿和附件。群组栏可以收成一列头像。

对话里的每一行都是 Grok Bot 那种“小人 + 名字 + 时间 + 状态”的结构：形状与颜色取自画布上的同一只（同一份回调哈希），动作由真实运行状态驱动（在跑、等待、失败、刚交回）。

## 启动

- **已打包：**双击 `release/EasyWorkflow-win32-x64/EasyWorkflow.exe`，保留整个目录。显示界面和使用内置浏览器无需另装 Node 或 Chrome。
- **源码：**安装 Node 24+，运行 `npm install`，再运行 `npm run dev`。该命令构建界面并打开 Electron；关闭窗口时会关闭本次启动的后台。
- **构建：**`npm run build`，产物位于 `dist/desktop`。
- **打包：**`npm run package -- --zip`，生成应用目录和 ZIP，并核对文件清单、大小及可执行文件摘要。
- **并存测试版本：**`npm run package -- --name=EasyWorkflow-review`，输出到独立的 `release/EasyWorkflow-review/`，适合保留当前运行版本时验证新构建。

构建和打包当前预置策展包前，需要将 `VISLEXICON_ROOT` 设为包含规则资料的本机目录（其中有 `Spec.md` 与 `VisLexicon-browser-design-kit/`）。未配置或资料不完整时构建会直接报错，并保留已有产物；运行已打包应用不需要该源码目录。

应用菜单默认隐藏，按 **Alt** 可打开。“项目”菜单支持新建、打开、最近项目和在文件管理器中显示。默认项目目录为用户文档目录下的 `Easy Workflow/Projects/<项目名>`。模型配置、界面配置与项目数据分别保存；旧项目迁移只复制，不移动或删除来源。

## 项目与数据

流水线库支持从模板创建、安装已有包，也可点“从空白开始”添加程序节点、拖动位置并通过端口连接。选择节点后编辑输入输出契约、输入映射和验收条件；草稿在明确安装前不生效，关闭编辑面板或刷新页面后可恢复。当前空白图支持文本标准化、字词统计、高频词、汇总和 JSON 文件交付；复杂 Agent、外部工具及条件/退回流程继续通过模板或包声明接入。

每个项目包含 `PROJECT.md`、`journal.db`、`evidence/`、`published/`、`cases/`、`context/`、`work/` 和 `LESSONS.md`。日志记录状态变化；每件任务的 `CASE.md` 与 `case.json` 保留跨轮次的证据、动作和审查往来，重启时可从日志重建。经验草案绑定具体的验证任务，经过失败样本重跑和已发布条目回归后，仍需用户批准才能追加到角色手册。

预置策展包读取 VisLexicon 的分类规则、风格规则和条目校验器。可通过应用菜单连接本机资料目录；没有连接资料时可以查看工作台，候选库为空。已发布产物写进当前项目，写入外部正式目录需要用户确认。

桌面采集复用内置浏览器的持久标签页和登录会话。登录墙、验证页或授权失败会保留现场并提示处理，程序不会填写凭据或绕过验证。独立服务使用本机 Chrome/Edge 的持久 profile；录屏和图像处理需要 `ffmpeg`。应用恢复未结束的轮次时先暂停，由用户选择继续。

## Agent 接入

`npm run server` 可独立运行，默认监听 `http://127.0.0.1:4317`。`FACTORY_VAR` 指定项目目录，`FACTORY_PORT` 指定端口；设置 `FACTORY_TOKEN` 后，请求使用 `Authorization: Bearer <token>`。凭据不得写进提示词、日志或仓库。

先读取 `GET /api/agent/bootstrap` 获取当前能力索引，再按需读取 `/api/agent/tools/<name>` 的参数契约，向 `/api/tools/<name>` 提交 JSON：

```text
POST /api/tools/status          {}
POST /api/tools/feed_urls       {"urls":["https://example.org"]}
POST /api/tools/inspect         {"token":"投料回执中的任务 ID"}
POST /api/tools/read_report     {"runId":"运行回执中的轮次 ID"}
```

成功回执包含 `ok, tool, result, summary, seq, runId`；错误包含 HTTP 状态与 `code, error`。快照、增量事件和日志分别位于 `/api/state`、`/api/events`、`/api/journal`。写请求中断后先检查回执、任务与日志，再决定是否重试。

控制面提供 stdio MCP：客户端启动 `node server/mcp.ts`，通过 `easy_workflow_help` 查询能力，通过 `easy_workflow_call` 调用。工位 Agent 只得到本工位的 `env_help`、`env_call` 和 `submit`，不能取得全局调度或批准权限。闭源 launcher 接口和完整协议见 [Agent 接入契约](docs/mcp-agent-contracts.md)；协议测试通过不代表所有厂商客户端都已完成真实模型验证。

Pi 客户端可运行一次 `npm run pi:install` 安装自动发现扩展；已有会话执行 `/reload`。之后每次请求自动读取当前服务的简短能力说明，无需手工复制端口和 token。其他客户端也可直接使用 HTTP 接口。

## 模型与依赖

默认模型执行使用 Pi 的 `pi-agent-core` 与 `pi-ai`。配置读取本机 Pi 的 `settings.json`、`models.json` 和 `auth.json`；`PI_CODING_AGENT_DIR` 可选择配置目录，`FACTORY_PROVIDER` / `FACTORY_MODEL` 可覆盖模型选择。配置了 `FACTORY_STATION_COMMAND` 的工位使用外部 launcher，其参数和返回契约见接入文档。

模型请求遵循代理设置，本地请求直连。开跑体检会执行一次输出上限为 1024 tokens 的真实模型请求，验证凭据和推理接口，会产生少量用量。Pi 工位遇到瞬断时，保留已完成的工具结果，在原时限内继续一次；不会从头重做整个工位。

新记录的耗时色条使用模型等待、输出和工具调用的真实起止时间，并显示并行活动。旧记录的分项比例仍标注估算；Token 色条始终为比例估算。缺少用量、缓存或结束时间时保留未知状态，累计并行工作时间与整轮时间分别统计。

消息界面使用 Pi Web UI 的部分组件；来源、改动说明和 MIT 许可保存在 `ui/src/vendor/pi-web-ui/`，发布构建携带许可。Electron、Playwright 和其他依赖的准确版本见 `package-lock.json`。产品构建不包含私有证据、模型密钥、候选库、原始验收报告或 `legacy/`。

## 验证

```powershell
npm test
npm run typecheck
npx tsc -p ui/tsconfig.json
npm run build
npm run desktop:smoke
```

普通测试使用隔离项目与协议样本，不调用外部模型。`npm test` 默认按文件串行运行，避免多个浏览器套件抢占资源；`npm run typecheck` 同时检查后台与 UI。桌面检查覆盖 Electron、共享浏览器、项目隔离、持久化和退出清理；真实站点产出另行验收，不用 fixture 代替。`scripts/check-pi-live.mjs` 使用实际模型进行只读验证，会消耗模型用量。规格逐项核对见[本轮审查记录](docs/spec-audit-2026-10-12.md)。

打包后可运行同样的桌面检查：

```powershell
node scripts/desktop-smoke.mjs --packaged --exe=release/EasyWorkflow-win32-x64/EasyWorkflow.exe
```

`FACTORY_PROFILE` 指向独立测试 profile，`FACTORY_VIEW_VAR` 以只读方式打开已有项目；`FACTORY_DESKTOP_TEST=1` 开启仅主进程可见的测试诊断。开发约定见 [AGENTS.md](AGENTS.md)。
