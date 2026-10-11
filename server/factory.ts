// The factory: compiles the packs, opens the journal, rebuilds state, restores any
// unfinished run after a crash (Spec F2.5, N3) and wires executors, the candidate pool,
// the dispatcher and the run report together.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CompiledFactory, CompiledNode, Stamped } from "../shared/types.ts";
import { apply, initialState, type FactoryState } from "../shared/project.ts";
import { compile, type Patch } from "./spec/compile.ts";
import { Journal } from "./journal.ts";
import { Broker } from "./broker.ts";
import { EvidenceStore } from "./evidence.ts";
import { Runtime, type Executor, type TokenRun } from "./runtime.ts";
import { runAgentStation } from "./agent-station.ts";
import { pack } from "../packs/vislexicon/pack.ts";
import { TOOLS, canonical, type Services } from "../packs/vislexicon/tools.ts";
import { agentDefs, warmStyleLib } from "../packs/vislexicon/agents.ts";
import { loadCatalog, loadPublished, type CatalogEntry } from "../packs/vislexicon/env.ts";
import { ControlError } from "./errors.ts";
import { classifyFailure, type Failure } from "../shared/failures.ts";
import { readRole } from "./roles.ts";
import { ensureProject, projectPaths, type ProjectInfo } from "./workspace.ts";
import { configureNetwork } from "./network.ts";
import { Docs } from "./docs.ts";
import { Toolbox } from "./toolbox.ts";
import { configureAgentStations } from "./agent-station.ts";
import { preflight } from "./preflight.ts";
import type { Alert } from "../shared/types.ts";

export const ROOT = process.env.FACTORY_ROOT ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const VAR = process.env.FACTORY_VAR ?? path.join(ROOT, "var");

export interface Settings { browser: number; model: number; cpu: number; http: number; memoryFloorMB: number; socialPerMinute: number; socialPerDay: number }

export class Factory {
  compiled!: CompiledFactory;
  journal: Journal;
  state!: FactoryState;
  runtime!: Runtime;
  broker!: Broker;
  store: EvidenceStore;
  catalog: CatalogEntry[] = [];
  taken = new Set<string>();
  patches: Patch[] = [];
  settings: Settings;
  ephemeral = new Set<(e: Record<string, unknown>) => void>();
  project: ProjectInfo;
  docs!: Docs;
  toolbox!: Toolbox;

  constructor() {
    fs.mkdirSync(VAR, { recursive: true });
    const readOnly = process.env.FACTORY_READONLY === "1";
    this.project = readOnly ? { name: path.basename(VAR), dir: VAR, pack: "vislexicon", createdAt: "" } : ensureProject(VAR, process.env.FACTORY_PROJECT_NAME ?? path.basename(VAR));
    if (!readOnly && process.env.FACTORY_HTTP_CACHE !== "0") configureNetwork({ cacheDir: projectPaths(VAR).cache });
    this.journal = new Journal(path.join(VAR, "journal.db"), readOnly);
    this.store = new EvidenceStore(path.join(VAR, "evidence"));
    const saved = this.readJson<Partial<Settings> & { browserCapV2?: boolean }>(path.join(VAR, "settings.json"), {});
    // Browser pages were capped at three before Spec §30.6; lift old saved caps once to the new default.
    if (!saved.browserCapV2 && (saved.browser ?? 0) <= 3) delete saved.browser;
    this.settings = { browser: 8, model: 8, cpu: 4, http: 6, memoryFloorMB: 1024, socialPerMinute: 6, socialPerDay: 300, ...saved };
    this.patches = this.readJson(path.join(VAR, "patches.json"), []);
  }

  private readJson<T>(file: string, fallback: T): T { try { return JSON.parse(fs.readFileSync(file, "utf8")) as T; } catch { return fallback; } }

  async boot() {
    this.compiled = compile([pack], this.patches);
    if (this.compiled.issues.length) throw new ControlError(422, "invalid_spec", "规格校验失败，未启动运行时", this.compiled.issues);
    this.state = initialState(this.compiled);
    for (const e of this.journal.read(0)) apply(this.state, e);
    this.journal.subscribe((e) => apply(this.state, e));
    if (process.env.FACTORY_READONLY !== "1" && this.state.digest !== this.compiled.digest) this.journal.append({ kind: "factory.loaded", digest: this.compiled.digest, specVersion: this.compiled.specVersion });
    this.broker = new Broker({ browser: this.settings.browser, model: this.settings.model, cpu: this.settings.cpu, http: this.settings.http }, this.settings.memoryFloorMB);
    this.docs = new Docs(this, VAR, this.project.name);
    this.toolbox = new Toolbox({ journal: this.journal, broker: this.broker, docs: () => this.docs });
    configureAgentStations({ docs: () => this.docs, toolbox: () => this.toolbox });
    const defs = agentDefs(this.store);
    const services: Services = {
      store: this.store, workDir: path.join(VAR, "work"), publishDir: path.join(VAR, "published"),
      tryBrowser:()=>this.broker.tryAcquire("browser"),
      inFlight: (self) => new Set([...this.runtime.tokens.values()].filter((t) => !t.finished && t.id !== self && t.data.key).map((t) => String(t.data.key))),
    };
    const executors = (n: CompiledNode): Executor | null => {
      if (n.tool && TOOLS[n.tool]) return (ctx) => TOOLS[n.tool!](ctx, services);
      const def = defs[n.key];
      return def ? (ctx) => runAgentStation(def, ctx) : null;
    };
    this.runtime = new Runtime(this.compiled, this.journal, this.broker, pack.conditions, executors);
    this.wireRecovery();
    if (process.env.FACTORY_READONLY === "1") { this.catalog = loadCatalog(); return; }
    this.wireDocs();
    void warmStyleLib();
    this.loadStock();
    this.recoverLegacyFailures();
    for(const c of Object.values(this.state.recoveries))if(c.failure?.tag==="tool_error") {
      const failure=classifyFailure(c.failure.message,{url:c.url});
      if(failure.tag!=="tool_error")this.journal.append({kind:"candidate.disposition",candidate:{...c,failure}});
    }
    this.restore();
    this.runtime.tick();
  }

  /* -------------------------------------------------------------- stock (候选层 / 已发布) */

  private loadStock() {
    this.catalog = loadCatalog();
    const publishedHosts = new Set(loadPublished().map((p) => p.domain.replace(/^www\./, "")));
    for (const t of Object.values(this.state.tokens)) if (t.source === "candidates/pool") this.taken.add(t.item);
    const left = this.catalog.filter((c) => !this.taken.has(c.id) && !publishedHosts.has(this.hostOf(c.canonicalUrl)));
    const pool = "candidates/pool";
    const localPublished = fs.existsSync(path.join(VAR, "published")) ? fs.readdirSync(path.join(VAR, "published")).length : 0;
    const deferred=Object.values(this.state.recoveries).filter(c=>c.disposition==="retry").length;
    const want: Record<string, number> = { [pool]: left.length+deferred, "curation/published": publishedHosts.size + localPublished };
    for (const [node, stock] of Object.entries(want)) {
      this.runtime.stock.set(node, stock);
      if (this.state.nodes[node]?.stock !== stock) this.journal.append({ kind: "stock.set", node, stock, note: node === pool ? "VisLexicon 候选目录（去掉已发布、已取走）" : "VisLexicon 已发布 + 本工厂发布" });
    }
    for (const [k, n] of Object.entries(this.state.nodes)) if (!this.runtime.stock.has(k) && n.stock) this.runtime.stock.set(k, n.stock);
  }

  private hostOf(u: string) { try { return new URL(u).hostname.replace(/^www\./, ""); } catch { return u; } }

  /* -------------------------------------------------------------- documents, alerts, preflight (Spec §30–§31) */

  private wireDocs() {
    this.journal.subscribe((e) => {
      const a = e.kind === "attempt.finished" || e.kind === "attempt.started" ? this.state.attempts[e.attempt] : undefined;
      if (a) { this.docs.schedule("context", a.node); const t = this.state.tokens[a.token]; if (t) this.docs.schedule("case", t.item); }
      else if (e.kind === "case.noted") this.docs.schedule("case", e.caseId);
      else if (e.kind === "context.noted") this.docs.schedule("context", e.node);
      else if (e.kind === "token.finished" || e.kind === "consult.opened" || e.kind === "consult.replied" || e.kind === "consult.closed") { const t = this.state.tokens[e.token]; if (t) this.docs.schedule("case", t.item); }
    });
    try { this.docs.writeAllContexts(); } catch (err) { console.warn("contexts", (err as Error).message); }
  }

  raiseAlert(alert: Alert) {
    if (this.state.alerts?.[alert.id]) return;
    this.journal.append({ kind: "alert.raised", alert });
    if (alert.kind === "model") this.broker.modelHold = alert.message;
  }

  clearAlert(id: string, reason: string) {
    const a = this.state.alerts?.[id];
    if (!a) return false;
    this.journal.append({ kind: "alert.cleared", id, reason });
    if (a.kind === "model" && !Object.values(this.state.alerts ?? {}).some((x) => x.kind === "model")) { this.broker.modelHold = null; this.runtime.schedule(); }
    return true;
  }

  private lastPreflight = 0;
  /** Runs the health check before a run starts or resumes; throws with the failed items. */
  async ensureReady(force = false) {
    if (process.env.FACTORY_PREFLIGHT === "0" || process.env.FACTORY_READONLY === "1") return null;
    if (!force && this.state.preflight?.ok && Date.now() - this.lastPreflight < 10 * 60_000) return this.state.preflight;
    const r = await preflight(VAR, this.broker);
    this.lastPreflight = Date.now();
    this.journal.append({ kind: "preflight.checked", ok: r.ok, checks: r.checks });
    if (!r.ok) {
      const bad = r.checks.filter((c) => !c.ok);
      this.raiseAlert({ id: "preflight", level: "red", kind: "preflight", message: `开跑体检未通过：${bad.map((c) => `${c.label}（${c.detail}）`).join("；")}`, nextAction: bad.map((c) => c.fix).filter(Boolean).join("；") || "按 ENV.md 修复后重试" });
      throw new ControlError(412, "preflight_failed", `开跑体检未通过：${bad.map((c) => c.label).join("、")}`, bad);
    }
    this.clearAlert("preflight", "体检通过");
    if (r.checks.find((c) => c.id === "model")?.ok) for (const a of Object.values(this.state.alerts ?? {})) if (a.kind === "model") this.clearAlert(a.id, "体检确认模型可用");
    return r;
  }

  private wireRecovery() {
    this.runtime.onRecovery = (token, failure) => this.recordRecovery(token, failure);
    this.runtime.onAlert = (token, node, failure) => {
      const kind: Alert["kind"] = failure.tag === "network_tls" ? "tls" : failure.tag === "model_unavailable" ? "model" : "auth";
      this.raiseAlert({ id: kind === "model" ? "model" : `${kind}:${token.item}`, level: "red", kind, message: `${token.title || token.item}：${failure.message}`.slice(0, 400), nextAction: failure.nextAction, token: token.id, item: token.item, node: node.key, url: failure.url ?? token.url });
    };
    this.runtime.onPark = token => this.recordRecovery(token, {tag:"run_ended",category:"system",message:"本轮结束，工作尚未完成",url:token.url,retryable:true});
  }

  private recordRecovery(token:Pick<TokenRun,"id"|"item"|"url"|"title"|"source">,failure:Failure) {
    const previous=this.state.recoveries[token.item],disposition=failure.retryable?"retry":"removed";
    if(previous?.token===token.id&&previous.disposition===disposition)return;
    if(!this.state.tokens[token.id]?.data.failure)this.journal.append({kind:"token.data",token:token.id,patch:{failure}});
    this.journal.append({kind:"candidate.disposition",candidate:{item:token.item,token:token.id,url:token.url,title:token.title||token.item,source:token.source,category:this.state.tokens[token.id]?.category,disposition,failure}});
    const delta=Number(disposition==="retry")-Number(previous?.disposition==="retry");
    if(delta)this.runtime.stockDelta("candidates/pool",delta,`${token.item}：${disposition==="retry"?"退回待重试":"移除无效网址"}`);
  }

  private recoverLegacyFailures() {
    // Repair the old "fetch failed → successful rejection" and exhausted capture
    // paths once, without rewriting evidence or rerunning paid model work.
    const latest = new Map(Object.values(this.state.tokens).sort((a,b)=>a.createdAt-b.createdAt).map(t=>[t.item,t]));
    for(const token of latest.values()) {
      if(token.status==="manual"&&token.data.recoveryStation&&token.reason==="没有可走的下一步（分支条件都不成立）"){
        const last=this.state.attempts[token.attempts.at(-1)??""];
        const next=last&&(this.runtime.outFlow.get(last.node)??[]).filter(e=>!e.when||pack.conditions[e.when]?.(token.data));
        const station=next?.length===1&&this.runtime.runnable(this.runtime.nodes.get(next[0].to)!)?next[0].to:last?.node;
        if(station){
          const parkedAt=token.finishedAtNode;
          if(parkedAt&&this.runtime.nodes.get(parkedAt)?.kind==="store")this.runtime.stockDelta(parkedAt,-1,`${token.item}：恢复调度后移回候选`);
          this.journal.append({kind:"token.finished",token:token.id,node:station,status:"parked",reason:"恢复分支状态不完整，现已修复；保留产物并从后续工位继续"});
          this.recordRecovery(token,{tag:"tool_error",category:"system",message:"恢复分支状态不完整，现已修复；从后续工位继续",retryable:true,url:token.url});
        }
      }
      if(this.state.recoveries[token.item]||!["rejected","manual","parked"].includes(token.status))continue;
      const attempts=token.attempts.map(id=>this.state.attempts[id]).filter(Boolean);
      const failed=[...attempts].reverse().find(a=>a.ok===false||/^打不开[：:]|^HTTP [45]\d\d/.test(a.summary??""));
      if(!failed&&token.status!=="parked")continue;
      if(failed&&!/fetch|screenshot|navigation|ERR_|Timeout|打不开|HTTP|网址/i.test(failed.error??failed.summary??""))continue;
      const invalid=/^https?:\/\/git\+https?\//i.test(token.url)||!canonical(token.url);
      const failure:Failure=!failed&&token.status==="parked"
        ? {tag:"run_ended",category:"system",message:token.reason??"本轮结束，工作未完成",url:token.url,retryable:true}
        : classifyFailure(failed?.error??failed?.summary,{url:token.url,stage:invalid?"url":undefined});
      this.recordRecovery(token,failure);
    }
  }

  candidateFailures(filter:{tag?:string;disposition?:string}={}) {
    return Object.values(this.state.recoveries).filter(c=>(!filter.tag||c.failure?.tag===filter.tag)&&(!filter.disposition||c.disposition===filter.disposition)).sort((a,b)=>b.at-a.at);
  }

  choosePreview(item:string,role:"breadth"|"proof",url:string) {
    const c=this.state.recoveries[item];
    if(!c||c.disposition!=="retry")throw new ControlError(409,"candidate_not_waiting","该候选当前不在待处理队列");
    let selected:URL,entry:URL;
    try{selected=new URL(url);entry=new URL(c.url);}catch{throw new ControlError(400,"invalid_url","请输入完整网页地址");}
    const host=entry.hostname.replace(/^www\./,"");
    if(!["http:","https:"].includes(selected.protocol)||selected.username||selected.password||!(selected.hostname.replace(/^www\./,"")===host||selected.hostname.endsWith('.'+host)))throw new ControlError(400,"invalid_preview_page","采集页必须是该站点或其子域的 HTTP(S) 网页");
    if(/\.(txt|md|json|xml|zip|pdf|png|jpe?g|svg|mp4)$/i.test(selected.pathname))throw new ControlError(400,"not_visual_page","请选择可视页面，不能用数据文件或下载文件代替截图");
    if(!this.state.tokens[c.token]?.data.canonical)throw new ControlError(409,"missing_classification","请先完成首页抓取与分类，再指定采集页");
    return this.retryCandidates({items:[item],count:1,preview:{role,url:selected.href}})[0];
  }

  retryCandidates(filter:{tag?:string;items?:string[];count:number;preview?:{role:"breadth"|"proof";url:string}}) {
    if(this.runtime.paused&&this.runtime.running)throw new ControlError(409,"run_paused","请先继续或结束当前暂停的轮次");
    const selected=this.candidateFailures({tag:filter.tag,disposition:"retry"}).filter(c=>!filter.items||filter.items.includes(c.item)).slice(0,filter.count);
    if(!selected.length)return [];
    for(const c of selected)for(const k of ["tls","auth"])this.clearAlert(`${k}:${c.item}`,"站长已处理，按原因重试");
    if(!this.runtime.running)this.runtime.start(`失败重试 × ${selected.length}`);
    return selected.map(c=>{
      const previous=this.state.tokens[c.token];
      const failedAt=filter.preview?`curation/${filter.preview.role}`:previous?.finishedAtNode;
      const checkpoint=previous?.data.canonical&&failedAt&&this.compiled.nodes.some(n=>n.key===failedAt&&this.runtime.runnable(n))?failedAt:"candidates/tidy";
      const data:Record<string,unknown>=checkpoint==="candidates/tidy"?{}:structuredClone(previous.data);
      delete data.failure;delete data.gate;delete data.digest;
      if(filter.preview){
        data.previewChoices={...(data.previewChoices as object??{}),[filter.preview.role]:filter.preview.url};
        const repairs={...(data.shotRepairs as Record<string,unknown>??{})};delete repairs[filter.preview.role];data.shotRepairs=repairs;
      }
      const recoveryRoot=String(previous?.data.recoveryRoot??(previous&&this.state.attempts[previous.attempts[0]]?.node)??checkpoint);
      const completed=new Map((previous?.attempts??[]).map(id=>this.state.attempts[id]).filter(Boolean).map(a=>[a.node,a.ok]));
      const t=this.runtime.create(checkpoint,{item:c.item,url:c.url,title:c.title,source:"candidates/pool",category:c.category,data:{...data,express:true,retryOf:c.token,retryTag:c.failure?.tag,recoveryStation:checkpoint,recoveryRoot}});
      if(checkpoint!=="candidates/tidy") {
        t.entry=recoveryRoot;t.closure=this.runtime.closureOf(recoveryRoot);
        const invalidated=this.runtime.descendants(t,checkpoint);
        t.done=new Set([...(previous.data.checkpointDone as string[]??[]),...[...completed].filter(([,ok])=>ok).map(([key])=>key)].filter(key=>!invalidated.has(key)));
        this.runtime.restoreFlow(t);
        t.data.checkpointDone=[...t.done];this.journal.append({kind:"token.data",token:t.id,patch:{checkpointDone:[...t.done]}});
      }
      if(previous&&checkpoint!=="candidates/tidy"){
        for(const id of previous.evidence){const ev=this.state.evidence[id];if(!ev)continue;this.journal.append({kind:"evidence.added",evidence:{...ev,id:`${ev.id}-${t.id}`,token:t.id,at:Date.now(),meta:{...ev.meta,reusedFrom:ev.id}}});}
        this.journal.append({kind:"token.data",token:previous.id,patch:{retriedBy:t.id}});
      }
      this.journal.append({kind:"dispatch.note",node:checkpoint,tone:"info",text:`${c.title} 从${this.compiled.nodes.find(n=>n.key===checkpoint)?.name??checkpoint}继续，保留此前成果`});
      this.journal.append({kind:"candidate.disposition",candidate:{...c,token:t.id,disposition:"claimed"}});
      this.runtime.stockDelta("candidates/pool",-1,`${c.item} 已取出重试`);return t;
    });
  }

  pull(count: number, filter: { category?: string; query?: string; includeRepos?: boolean } = {}) {
    const publishedHosts = new Set(loadPublished().map((p) => p.domain.replace(/^www\./, "")));
    const q = filter.query?.toLowerCase();
    const pick = this.catalog.filter((c) => !this.taken.has(c.id) && !publishedHosts.has(this.hostOf(c.canonicalUrl))
      && (!filter.category || c.category === filter.category || (c.subcategories ?? []).includes(filter.category))
      && (filter.includeRepos || !/^https?:\/\/(www\.)?(github\.com|gitlab\.com|npmjs\.com|www\.npmjs\.com)\//i.test(canonical(c.canonicalUrl)??c.canonicalUrl))
      && (!q || `${c.name} ${c.canonicalUrl} ${c.descriptionZh ?? ""} ${(c.tags ?? []).join(" ")}`.toLowerCase().includes(q)));
    // Spread the pick over the list so one run is not 20 sites from the same letter.
    const step = Math.max(1, Math.floor(pick.length / Math.max(1, count)));
    const chosen: CatalogEntry[] = [];
    for (let i = 0; i < pick.length && chosen.length < count; i += step) chosen.push(pick[i]);
    if (!chosen.length) return [];
    if (!this.runtime.running) this.runtime.start(filter.category ? `${filter.category} × ${chosen.length}` : `候选 × ${chosen.length}`);
    const out: TokenRun[] = [];
    for (const c of chosen) {
      this.taken.add(c.id);
      this.runtime.stockDelta("candidates/pool", -1);
      const url = canonical(c.canonicalUrl) ?? c.canonicalUrl;
      out.push(this.runtime.create("candidates/route", {
        item: c.id, url, title: c.name, source: "candidates/pool", category: c.category,
        data: { canonical: url, host: this.hostOf(url), catalog: { category: c.category, subcategories: c.subcategories, descriptionZh: c.descriptionZh } },
      }));
    }
    return out;
  }

  /** Hand-pasted URLs enter the candidate layer at 整理 and pass the pool express. */
  feed(urls: string[]) {
    const clean = [...new Set(urls.map((u) => u.trim()).filter(Boolean))];
    if (!clean.length) return [];
    if (!this.runtime.running) this.runtime.start(`手贴 × ${clean.length}`);
    return clean.map((u) => this.runtime.create("candidates/tidy", { item: this.hostOf(canonical(u) ?? u), url: u, source: "manual", data: { express: true } }));
  }

  /* -------------------------------------------------------------- restart */

  private restore() {
    const rt = this.runtime;
    rt.locked = new Set(this.state.lockedStations);
    const live = Object.values(this.state.workers).filter((w) => !w.retiredAt);
    rt.ensureWorkers(live.map((w) => ({ node: w.node, worker: w.id, label: w.label })));
    const run = this.state.run;
    const resumable=run.status === "running" || run.status === "paused";
    rt.running = resumable; rt.paused = resumable&&(run.status === "paused" || process.env.FACTORY_START_PAUSED === "1"); rt.runStartedAt = run.startedAt;
    if (rt.paused && this.state.run.status === "running") this.journal.append({ kind: "run.paused", runId: run.id });
    // Which nodes each token has finished, per the journal (returns reset descendants).
    const done = new Map<string, Set<string>>(Object.values(this.state.tokens).map(t=>[t.id,new Set((t.data.checkpointDone as string[])??[])]));
    const notes=new Map<string,TokenRun["notes"]>();
    for (const e of this.journal.read(0)) {
      if(e.kind==="token.returned"){
        const entries=notes.get(e.token)??new Map();entries.set(e.to,{reason:e.reason,byHuman:e.byHuman});notes.set(e.token,entries);
      }else if(e.kind==="attempt.finished"&&e.error!=="restart"&&e.error!=="stale"){
        const a=this.state.attempts[e.attempt];if(a)notes.get(a.token)?.delete(a.node);
      }
      if (e.kind === "attempt.finished" && e.ok && e.error !== "stale") {
        const a = this.state.attempts[e.attempt];
        if (a) (done.get(a.token) ?? done.set(a.token, new Set()).get(a.token)!).add(a.node);
      } else if (e.kind === "token.returned") for (const k of e.reset ?? []) done.get(e.token)?.delete(k);
      else if (e.kind === "token.queued" && this.compiled.nodes.find((n) => n.key === e.node)?.kind === "store") (done.get(e.token) ?? done.set(e.token, new Set()).get(e.token)!).add(e.node);
    }
    let requeued = 0, voided = 0;
    for (const ts of Object.values(this.state.tokens)) {
      const entry = String(ts.data.recoveryRoot??this.state.attempts[ts.attempts[0]]?.node ?? (ts.source === "manual" ? "candidates/tidy" : "candidates/route"));
      const t: TokenRun = {
        id: ts.id, item: ts.item, url: ts.url, title: ts.title, source: ts.source, entry, data: { ...ts.data },
        closure: rt.closureOf(entry), done: done.get(ts.id) ?? new Set(), dead: new Set(), edgeLive: new Map(), inflight: new Set(),
        queuedAt: new Map(), failures: new Map(), rounds: { ...ts.rounds }, epoch: 0, finished: ts.status!=="active", notes: notes.get(ts.id)??new Map(),
        finishedStore:ts.finishedAtNode&&rt.nodes.get(ts.finishedAtNode)?.kind==="store"?ts.finishedAtNode:undefined,
      };
      rt.restoreFlow(t);
      rt.tokens.set(t.id, t);
      if(t.finished||!resumable)continue;
      for (const aid of ts.attempts) {
        const a = this.state.attempts[aid];
        if (a && a.endedAt === undefined) {
          this.journal.append({ kind: "attempt.finished", attempt: aid, ok: false, summary: "进程重启：这次处理作废，重新排队", ms: Date.now() - a.startedAt, queuedMs: 0, error: "restart" });
          voided++;
        }
      }
      for (const old of [...ts.at]) {
        // Preparation's former pass-through stations were merged into tidy.
        // Resume any parked-in-flight legacy item there without losing its data.
        const k = old === "candidates/extract" || old === "candidates/index" ? "candidates/tidy" : old;
        if (k !== old) {
          t.done.delete(k);
          this.journal.append({ kind: "token.queued", token: t.id, node: k, from: old, returned: true });
        }
        if (t.done.has(k)) continue;
        const q = rt.queues.get(k);
        if (q && !q.includes(t.id)) { q.push(t.id); t.queuedAt.set(k, Date.now()); requeued++; }
      }
    }
    if (requeued || voided) this.journal.append({ kind: "dispatch.note", tone: "warn", text: `重启后从日志续跑：${requeued} 件货重新排队，${voided} 次中断的处理作废重做；已完成的工位结果不重做` });
    rt.schedule();
  }

  /* -------------------------------------------------------------- settings / layout / patches */

  saveSettings(next: Partial<Settings>) {
    this.settings = { ...this.settings, ...next };
    fs.writeFileSync(path.join(VAR, "settings.json"), JSON.stringify({ ...this.settings, browserCapV2: true }, null, 2));
    Object.assign(this.broker.limits, { browser: this.settings.browser, model: this.settings.model, cpu: this.settings.cpu, http: this.settings.http });
    this.broker.memoryFloorMB = this.settings.memoryFloorMB;
    this.runtime.schedule();
  }

  layoutFile() { return process.env.FACTORY_LAYOUT ?? path.join(ROOT, "layout", "factory.layout.json"); }
  readLayout() { return this.readJson<Record<string, unknown>>(this.layoutFile(), {}); }
  writeLayout(layout: Record<string, unknown>) {
    fs.mkdirSync(path.dirname(this.layoutFile()), { recursive: true });
    fs.writeFileSync(this.layoutFile(), JSON.stringify(layout, null, 2));
  }

  proposePatch(p: Omit<Patch, "status" | "at" | "id">) {
    const patch: Patch = { ...p, id: `p-${String(this.patches.length + 1).padStart(4, "0")}`, status: "proposed", at: new Date().toISOString() };
    const trial = compile([pack], [...this.patches, { ...patch, status: "accepted" }]);
    this.patches.push(patch);
    fs.writeFileSync(path.join(VAR, "patches.json"), JSON.stringify(this.patches, null, 2));
    this.journal.append({ kind: "spec.patched", patch: patch.id, summary: patch.summary, status: "proposed" });
    return { patch, issues: trial.issues, nodes: trial.nodes.length, digest: trial.digest };
  }

  decidePatch(id: string, accept: boolean) {
    const p = this.patches.find((x) => x.id === id);
    if (!p || p.status !== "proposed") throw new ControlError(409, "patch_not_proposed", "补丁不存在或已处理");
    let trial: CompiledFactory | undefined;
    if (accept) {
      trial = compile([pack], this.patches.map((x) => x.id === id ? { ...x, status: "accepted" as const } : x));
      if (trial.issues.length) throw new ControlError(422, "invalid_spec", "补丁校验未通过", trial.issues);
      const missing = trial.nodes.filter((n) => n.kind !== "source" && n.kind !== "store" && !n.dormant && trial!.lines.find((l) => l.id === n.line)?.wired && !this.runtime.executors(n));
      if (missing.length) throw new ControlError(422, "missing_executor", "新增工位缺少执行器，不能生效", missing.map((n) => n.key));
      const missingRoles=trial.nodes.filter(n=>{try{readRole(n.key);return false;}catch{return true;}});
      if(missingRoles.length)throw new ControlError(422,"missing_role","节点缺少 ROLE.md 职责契约，不能生效",missingRoles.map(n=>n.key));
      if (this.runtime.running || [...this.runtime.workers.values()].some((pool) => pool.some((w) => w.busy))) throw new ControlError(409, "run_active", "请先结束本轮并等待在途工人退出，再应用规格补丁");
    }
    p.status = accept ? "accepted" : "rejected";
    fs.writeFileSync(path.join(VAR, "patches.json"), JSON.stringify(this.patches, null, 2));
    this.journal.append({ kind: "spec.patched", patch: id, summary: p.summary, status: p.status });
    if (trial) {
      const previous = this.runtime;
      previous.dispose();
      for (const pool of previous.workers.values()) for (const w of pool) this.journal.append({ kind: "worker.retired", node: w.node, worker: w.id, reason: "规格新版本生效，重新配员" });
      this.compiled = trial;
      this.runtime = new Runtime(trial, this.journal, this.broker, pack.conditions, previous.executors);
      this.wireRecovery();
      this.runtime.stock = previous.stock;
      this.runtime.tokens = previous.tokens;
      for (const t of this.runtime.tokens.values()) t.closure = this.runtime.closureOf(t.entry);
      this.runtime.locked = new Set([...previous.locked].filter((key) => this.runtime.nodes.has(key)));
      this.journal.append({ kind: "factory.loaded", digest: trial.digest, specVersion: trial.specVersion });
      this.runtime.ensureWorkers([]);
      this.runtime.tick();
    }
    return true;
  }

  emit(e: Record<string, unknown>) { for (const l of this.ephemeral) l(e); }

  events(since: number): Stamped[] { return [...this.journal.read(since)]; }
}
