// A project is one folder that holds everything a run produces (Spec §30.1):
// journal, evidence, published entries, reports, case files, node CONTEXT.md,
// lessons and the HTTP cache. Agents work inside <project>/work/<task>.
import fs from "node:fs";
import path from "node:path";

export interface ProjectInfo { name: string; dir: string; pack: string; createdAt: string }

export const projectPaths = (dir: string) => ({
  root: dir,
  context: path.join(dir, "context"),
  cases: path.join(dir, "cases"),
  cache: path.join(dir, "cache", "http"),
  lessons: path.join(dir, "LESSONS.md"),
  project: path.join(dir, "PROJECT.md"),
  env: path.join(dir, "ENV.md"),
  manifest: path.join(dir, "project.json"),
  work: path.join(dir, "work"),
});

const LEGACY_PROJECT_TEMPLATE = (name: string) => `# ${name}

> 项目说明。站长维护；主调度可以起草修改，站长确认后生效。各 Agent 每次工作前都会读到这一页的摘要。

## 目标

把 VisLexicon 候选库里的网站做成达到发布标准的条目：先真的进站读懂，再取证、核验、著录，最后独立审核。

## 站长决定

- 编辑手记、导览和 alt 由编辑 Agent 起草，经独立审查后可以发布；站长在证据板抽查。
- 证书过期、需要登录时立即亮红灯通知站长，Agent 不绕过证书、不自动登录。
- 浏览器自动采集默认最多 8 页，内存不够时自动降低。

## 规则来源

- VisLexicon \`Spec.md\`（分类 §2、风格 §2.6.1、预览 §4.8）
- VisLexicon \`proposal/策展内容生产手册-给AI员工.md\`（条目结构、语气、自检清单）
- Easy Workflow \`Spec.md\` §30–§38

## 文件夹约定

| 位置 | 内容 |
|---|---|
| \`journal.db\` | 全部事件（唯一事实来源） |
| \`evidence/\` | 截图、录屏等证据（内容寻址） |
| \`published/\` | 通过发布闸门的条目 |
| \`cases/<任务>/CASE.md\` | 每件货的案卷 |
| \`context/<线>/<工位>/CONTEXT.md\` | 每个节点的实时上下文 |
| \`work/<任务>/\` | Agent 的临时工作目录 |
| \`cache/http/\` | 网页缓存（默认 6 小时） |
`;

const PROJECT_TEMPLATE = (name: string) => `# ${name}

> 项目说明。站长维护目标与验收要求，流水线包提供各节点职责、输入输出契约和执行器。

## 目标

按已安装工作流的入口契约接收任务，完成真实处理与独立审查，保留可核对的过程、证据和产物。具体业务要求写在这里或随任务输入提供。

## 工作约定

- 只执行本项目已接线且具有职责、schema 和执行器的工位。
- 取消、工具失败与待人工保持真实状态，不将未处理数据标为成功。
- 证书、身份验证及凭据由用户处理，不自动绕过或重登。
- 安装与修改结构必须在轮次结束且无在途任务时生效。

## 项目文件

- \`packs/installed.json\`：启用的包与不可变版本。
- \`journal.db\`：运行事件与恢复检查点。
- \`outputs/\`、\`published/\`、\`evidence/\`：工作流实际生成的产物与证据。
- \`cases/\`、\`context/\`：任务案卷与节点上下文。
- \`work/\`、\`cache/\`：任务工作目录和项目缓存。
`;

const LESSONS_TEMPLATE = `# 经验（LESSONS）

> 每轮结束后由复盘员起草，站长批准后写入对应节点 ROLE.md 的"已知坑"。未批准的条目只作参考，不约束 Agent。

| 日期 | 节点 | 现象 | 建议 | 状态 |
|---|---|---|---|---|
`;

/** Creates the folder layout and the human documents once; never overwrites them. */
export function ensureProject(dir: string, name = path.basename(dir), pack = "vislexicon"): ProjectInfo {
  const p = projectPaths(dir);
  for (const d of [p.root, p.context, p.cases, p.cache, p.work]) fs.mkdirSync(d, { recursive: true });
  if (!fs.existsSync(p.project)) fs.writeFileSync(p.project, PROJECT_TEMPLATE(name));
  if (!fs.existsSync(p.lessons)) fs.writeFileSync(p.lessons, LESSONS_TEMPLATE);
  let info: ProjectInfo;
  try { info = JSON.parse(fs.readFileSync(p.manifest, "utf8")); }
  catch { info = { name, dir, pack, createdAt: new Date().toISOString() }; fs.writeFileSync(p.manifest, JSON.stringify(info, null, 2)); }
  return { ...info, dir };
}

/** Installed packs define the project domain. Only an exact old automatic
 * document is migrated; any human edit, even a short note, remains untouched. */
export function synchronizeProjectPacks(dir: string, packIds: string[]): ProjectInfo {
  const paths = projectPaths(dir);
  const previous = JSON.parse(fs.readFileSync(paths.manifest, 'utf8')) as ProjectInfo;
  const pack = packIds.length ? [...new Set(packIds)].join(',') : 'generic';
  if (!packIds.includes('vislexicon') && fs.existsSync(paths.project)) {
    const current = fs.readFileSync(paths.project, 'utf8').replace(/\r\n/g, '\n');
    if (current === LEGACY_PROJECT_TEMPLATE(previous.name).replace(/\r\n/g, '\n')) fs.writeFileSync(paths.project, PROJECT_TEMPLATE(previous.name));
  }
  if (previous.pack !== pack) {
    const temporary = `${paths.manifest}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ ...previous, pack }, null, 2)); fs.renameSync(temporary, paths.manifest);
  }
  return { ...previous, dir, pack };
}

/** First lines of a markdown file without its title, for prompt envelopes. */
export function digest(file: string, max = 1200) {
  try { return fs.readFileSync(file, "utf8").replace(/^# .*\r?\n/, "").trim().slice(0, max); } catch { return ""; }
}
