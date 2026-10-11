# Pi Factory

将候选资源交给明确分工的工位，保留每一步的日志与证据，在画布里检查进度。当前策展线已经接入工具，其余六条业务线仍是待接入的规格。桌面壳、画布可独立打开；没有模型密钥也能查看、编辑布局和打开内置浏览器。

## 启动

- **已打包：**双击 `release/PiFactory-win32-x64/PiFactory.exe`，整个文件夹需保留在一起。无需另外安装 Node 或 Chrome 来显示界面和内置浏览器。
- **源码：**Node 24+，安装依赖后运行 `npm run dev`。该命令先构建界面，再打开 Electron，窗口关闭时自动关闭它创建的后台。
- **重新打包：**`npm run package -- --zip`。生成可双击目录与可分发 ZIP，校验文件清单、文件长度及解压后 exe 的 SHA-256；使用已经安装的 Electron，不会下载或打包第二份 Chromium。
- **仅构建：**`npm run build`。产物是 `dist/desktop`；运行 `node_modules/electron/dist/electron.exe dist/desktop` 可直接验证。

应用菜单默认隐藏，按 **Alt** 可打开“工作区”菜单。可连接本机 VisLexicon 资料目录；也可以选择包含 `journal.db` 的旧 `var` 目录，只读查看既有运行。只读查看不会复制证据或写回日志，切回“使用独立工作区”后即可正常操作。

## Agent 直接调用

`npm run server` 可独立运行，无需打开 Electron。默认地址为 `http://127.0.0.1:4317`；用 `FACTORY_VAR` 指定独立工作区、`FACTORY_PORT` 指定端口。设置 `FACTORY_TOKEN` 后，客户端请求带 `Authorization: Bearer <token>`；桌面客户端仍可使用原有会话 Cookie。

先读取 `GET /api/capabilities` 获取能力名称、输入 JSON Schema 和调用地址，再向 `POST /api/tools/<name>` 提交 JSON 参数。例如：

```text
POST /api/tools/status          {}
POST /api/tools/feed_urls       {"urls":["https://example.org"]}
POST /api/tools/inspect         {"token":"投料结果中的任务 ID"}
POST /api/tools/propose_patch   {"summary":"调整特写上限","ops":[{"op":"set","station":"curation/proof","field":"workers.max","value":3}]}
```

成功返回 `ok, tool, result, summary, seq, runId`；失败返回相应 HTTP 状态与 `code, error`。快照是 `/api/state`，增量事件是 `/api/events`，日志导出是 `/api/journal?since=<seq>`。证据地址可直接读取。内置主调度和界面调度动作使用同一份能力实现。

当前是单工作区本地服务，HTTP JSON 接口尚不是 MCP。只有接通执行器的线能运行；补丁需先结束本轮再接受。写请求没有持久幂等键，遇到响应中断先检查任务与日志，避免盲目重复投料。完整实现盘点与新要求见 `Spec.md` §20。

## 数据与运行

正式应用使用 Electron `userData` 下的 `workspace/`、`layout/`、`logs/`；不会将源码仓库的 `var` 作为可写目录。浏览器登录会话分别保存在四个持久分区中。关闭后重新打开仍保留登录信息；程序不会填写密码。恢复未结束的运行时先暂停，点击继续后才调度任务。

模型默认读取本机 Pi 的 `settings.json`、`models.json` 与 `auth.json`；`PI_CODING_AGENT_DIR` 可指定另一个 Pi 配置目录。`FACTORY_PROVIDER` / `FACTORY_MODEL` 可覆盖默认选择，OpenCode 可由 `OPENCODE_API_KEY` 覆盖凭据；旧 OpenCode 凭据作为后备。模型请求遵循 `HTTPS_PROXY` / `HTTP_PROXY`，本地请求直接连接。当前支持 API key 和兼容 OpenAI / Anthropic 协议的自定义模型；OAuth 与命令式凭据尚不支持。密钥不进入提示词、接口元数据或构建物。

桌面版的后台采集使用内置浏览器的同一组持久标签页与登录会话；无需另外启动 Chrome。独立服务使用持久的 Chrome/Edge profile。左侧浏览器图标显示真实页数；登录墙、验证页或同站授权请求失败会显示红点并保留现场。收藏和标签可拖动排序，收藏可增删，历史默认保留 30 天（可改 7 / 90 天）；定时清理历史不清 Cookie。旧社交分区的 Cookie 只在本机迁移一次。录屏仍需本机 `ffmpeg`；完整业务发布流程的生产验收仍以 `Spec.md` §20 的其余差距为准。

## Pi 自动认识 H2

运行一次 `npm run pi:install`，安装项目自带的轻量扩展到 Pi 的 `extensions/h2-factory.ts`。新 Pi 会话自动加载；已打开的会话执行 `/reload`。H2 GUI 或独立服务启动后发布私有连接文件，正常退出后清理，重启和切换工作区会自动更新。无需复制端口、token 或整篇说明。测试服务通过 `FACTORY_DISCOVERY=0` 避免覆盖真实连接。

每轮 Agent 请求只自动加入约 400 字能力说明。稳定入口只有 `h2_help`（索引或单个能力 schema）和 `h2_call`（调用）；底层仍使用同一份能力注册表。界面主调度使用相同入口，工位 Agent 只获取自己的职责、输入和结构化提交工具。新会话、恢复和压缩上下文后不依赖记忆旧说明。

其他客户端可直接读取 `/api/agent/bootstrap`，按需读取 `/api/agent/tools/<name>`，再调用 `/api/tools/<name>`。规范见 `AGENTS.md` 与 `Spec.md` §23。`node scripts/check-pi-live.mjs` 使用实际模型验证内部主调度与已安装 Pi CLI 的只读调用，会消耗少量模型用量；普通 `npm test` 不调用外部模型。

打包只包含业务代码、构建后的界面、必要规则、经过摇树优化的 pi/provider 依赖及 Playwright 运行库；不包含历史证据、候选数据、密钥、开发依赖或 legacy。没有连接 VisLexicon 资料时，仍显示完整工厂图，候选库为空；菜单可以连接资料。

## 验证

`npm test` 检查实际流水线几何，以及独立后台的能力发现、鉴权、参数校验、暂停状态、补丁生效、重启恢复与只读限制。前后端类型检查分别运行 `npx tsc -p tsconfig.json` 和 `npx tsc -p ui/tsconfig.json`。

构建后运行 `node scripts/check-control-ui.mjs`，检查字号、卡片密度、端口、画布钉住、工段统计、动效时效、Pi 消息安全渲染、交互报告及规格同步。截图与结果在 `artifacts/parts-workspace/`；带 `fixture` 的报告截图来自隔离验证数据，不是实际工作成果。Pi 消息渲染使用固定的原生协议样本，普通界面检查不调用模型。

启动后台与 `npm run ui:dev` 后，`npm run check:canvas` 会在 1366×768、1440×900、1920×1080 窗口检查实际显示字号、画布裁切、胶囊与普通节点的实时拖动、取消拖动及 SVG 端点对齐。布局保存请求被测试截获，不会改已有布局。可用 `-- --url=http://127.0.0.1:5318` 指定另一个预览端口。

浅色工作台按业务部分分组：彩色虚线框可点击查看汇总和过程，普通流有清晰箭头，分支使用独立端口；整理 / 提取 / 索引合并为“候选准备”，内部仍记录步骤。默认 1440×900 完整显示 9 张卡片，标题约 16.2px。钉住面板跟随画布平移缩放。W 回到工作视图，F 看全图，0 回到 100%；“定位工段”聚焦完整部分。当前布局版本为 4，旧坐标保存在 previousLayout。

右栏复用 Pi Web UI 消息组件，按原始消息顺序显示回答、可折叠思考与工具结果，支持停止回答及重启恢复。调度通知单独进入运行记录，异常有紧凑提示。进行中的节点有流光，传递的连线亮起后在约 3.6 秒内淡出；空跑显示“等待投料”。运行记录是交互仪表盘：可选轮次、流水线、时间段、工位及结果，并下钻步骤。节点检查面板中的“统计”提供紧凑耗时与用量图。

`npm run desktop:smoke` 用临时 profile 验证真实 Electron、共享浏览器与后台 CDP、会话复用、登录红点和页面保留、收藏历史重启持久化、后台回收与只读日志。不会开始真实模型任务。结果与截图在 `artifacts/desktop/`。Pi UI 组件来源与 MIT 许可在 `ui/src/vendor/pi-web-ui/`，发布构建会携带许可。

打包版可执行同样的验证：

```powershell
node scripts/desktop-smoke.mjs --packaged --exe=release/PiFactory-win32-x64/PiFactory.exe
```

供自动化使用的环境变量：`FACTORY_PROFILE` 指向独立测试 profile，`FACTORY_VIEW_VAR` 以只读方式打开指定日志目录，`FACTORY_DESKTOP_TEST=1` 开启仅主进程可见的测试诊断。Playwright 的 `_electron.launch` 可直接启动源码根目录、`dist/desktop` 或打包后的可执行文件。
