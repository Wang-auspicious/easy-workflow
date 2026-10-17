# Easy Workflow Agent 接入约定

禁止使用 Superpowers 及其流程。优先完成用户明确授权的实际工作，不增加流程性审批。

## TypeScript 与验证

- 新增和改动的 TypeScript 按 [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html) 编写：两空格缩进、单引号、优先 `const`、稳定成员使用 `readonly`、具名导出、边界数据以 `unknown` 接收并验证，不将多步状态变更压成一行。
- 保留本仓库 NodeNext、原生 TypeScript 加载和 `erasableSyntaxOnly` 约束；不机械引入不兼容的构造函数参数属性，也不为格式统一全仓重写。
- 验证围绕真实故障和数据完整性，优先补进已有回归文件。非必要不新增测试文件，不用镜像实现细节的测试制造覆盖率。

## 产品名称与公开文档

- 产品统一命名为 **Easy Workflow**，仓库名为 `easy-workflow`。公开页面、README、规格、应用文案及发布说明都使用这一名称。
- 产品定位为独立的多 Agent 工作流应用；不使用课程编号、评分映射、旧项目代号或其他产品的仿制定位。真实依赖、引用来源和第三方许可必须如实保留。
- 对外能力入口使用 `easy_workflow_help` / `easy_workflow_call`；内部兼容标识不得作为产品名称宣传。兼容数据与协议迁移不得丢失历史记录。
- 私有验收原始数据、个人绝对路径和凭据不随公共产品上传。公开文档以环境变量、项目目录和真实相对结构说明位置。
- 品牌整理只修改当前文件；不改写既有提交日期、提交标识或历史内容。

操作正在运行的 Easy Workflow 时，优先使用 `easy_workflow_help` / `easy_workflow_call`，不需要先读代码库、操作 GUI 或通读 Spec。Pi 扩展在请求开始前自动注入约 400 字的能力说明；参数按需查询 `easy_workflow_help({name})`。其他客户端先读取 `GET /api/agent/bootstrap`。

- 连接信息由本地服务发布到 Pi 配置目录；客户端通过自动发现或 `FACTORY_AGENT_CONNECTION` 定位连接文件。token 只用于请求认证，禁止写入提示词、日志、回复或仓库。
- 状态、工位、任务、证据和报告必须来自接口返回值。修改成功以调用回执和实际状态为准。
- 写请求超时不等于失败。先按任务 ID、runId、seq 查状态或日志，再决定是否重试。
- 当前只执行 `wired: true` 的线。主调度可用 `workflow_authoring` / `workflow_draft` / `workflow_trial` / `workflow_activate` 自主创建声明式工作流及修订自己创建的工作流；必须先在隔离目录真实试跑同一版本。主调度与用户同级：内置线与用户安装包的安装、结构改动同样由它决定，它也直接接受或拒绝补丁、经验和工位与自身模型配置。运行或暂停期间不能接受结构变更。
- 能力契约以当前服务的版本和 schema 为准。压缩上下文或开始新会话后仍由扩展注入短说明，不复制整份工具文档。
- 工位 Agent 只接受该工位职责、当前输入和 `submit` 契约；不要给每个工位塞入全局调度工具和完整软件说明。
- 每个节点的职责在 `packs/vislexicon/roles/<line>/<station>/ROLE.md`，主调度在 `packs/vislexicon/roles/dispatcher/ROLE.md`。运行时读取本节点契约；`read_role` 按需返回正文与版本。新增可执行节点必须同时提供角色契约及对应执行逻辑，不能仅写文档声称已支持恢复。
- 重试优先从失败工位继续，复用持久产物和证据。已转换 PNG 的引用必须更新到持久 WebP；目录图片、URL 和交给特写的链接必须来自同一个选定页面。不要裁整页文档当舞台，不要删除 Storybook 的页面路由参数。
- 网页操作使用 `browser` 能力和共享标签 ID。先查 state；需内容时 read，遇 attention 及时告知用户并保留页面，不自行重登。认证、Cookie 和 CDP 端点不进入提示词。
- 运行分析优先 read_report，按轮次核对，不把当前轮数据当历史结果；UI fixture 和测试样本不是实际产出。
- 处理结束不等于成功。工具失败必须查 candidate_failures：网络、登录、截图等异常退回候选库并记录标签；网址无效或 404/410 排除且保留审计。修复原因后用 retry_candidates 按 tag / items 重试，不盲目循环。结束本轮等待取消清理和报告回执。

开发时的产品与验收规则在 `Spec.md`，按任务读取相关段落。节点执行方式和模型必须据实显示：Agent 显示实际模型，程序节点标注程序执行。不要为了统一外观把程序节点伪装成 Agent。

## 分工（2026-10-11 起）

- 后端（`server/`、`shared/` 的业务逻辑、`packs/`、`app/` 主进程、`test/`）由 Codex 负责；交接清单见 `docs/handoff-2026-10-11-codex.md`。
- 用户体验与视觉（`ui/`）由 Claude 负责。改对方范围内的文件前先说明。
