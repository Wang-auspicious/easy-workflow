import {ControlError} from '../../server/errors.ts';
import {channelPayload} from '../../server/channels.ts';

export const businessLines = ['components', 'skills', 'sci-figure', 'ppt', 'image-fx'] as const;
export type BusinessLine = typeof businessLines[number];
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const invalid = (message: string): never => {throw new ControlError(422, 'business_input_invalid', message);};
function url(value: unknown, label: string): string {
  if (typeof value !== 'string') return invalid(`${label}需要完整 HTTP(S) 地址`);
  let parsed: URL;
  try {parsed = new URL(value);} catch {return invalid(`${label}需要完整 HTTP(S) 地址`);}
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password) invalid(`${label}需要不含凭据的 HTTP(S) 地址`);
  return value;
}

export function businessCatalog() {
  return [
    {id: 'components', name: '组件入库线', input: {url: '组件源站地址', data: {componentUrls: '可选：同站组件页面数组', componentLimit: '每批 1–100；余下页面自动续批'}}, downstream: 'atlas-feed', deliverable: '真实舞台截图、组件描述和审查记录'},
    {id: 'atlas-feed', name: '图鉴反哺线', upstream: 'components.instances.published', automatic: true, deliverable: '已发布组件按类型汇总；不接受绕过组件审查的直接投料'},
    {id: 'skills', name: 'Skill / DESIGN.md 线', input: {url: 'SKILL.md / DESIGN.md 原文件或可定位唯一文件的 GitHub 仓库'}, deliverable: '字节不变原件、出处与许可、简介'},
    {id: 'sci-figure', name: '科研绘图线', input: {url: '真实数据来源', data: {figure: {kind: 'line | bar | scatter', series: [{x: '真实有限数值数组', y: '同长度真实有限数值数组', label: '系列名'}], seed: '可选整数'}}}, alternative: 'figure.codeUrl + output + dataUrls；需已配置的隔离复现容器', deliverable: '真实 PNG/PDF、输入数据与可复现代码'},
    {id: 'ppt', name: 'PPT 线', input: {url: '完整 PPTX 或 PDF deck 的直接下载地址'}, deliverable: '完整原件、每页预览与审查记录'},
    {id: 'image-fx', name: '图像处理线', input: {url: '真实原图地址', data: {effect: {kind: 'grayscale | blur | contrast | edges | resize', imageUrl: '可省略，使用 url', radius: 'blur: (0,100]', factor: 'contrast: [0,10]', width: 'resize: 整数 [1,8192]'}}}, deliverable: '字节不变原图、真实处理结果、参数和限制'},
  ];
}

/** Validate before opening a run or reserving any downstream resources. */
export function businessInput(line: BusinessLine, source: string, input: Record<string, unknown> = {}) {
  url(source, '来源');
  const data = channelPayload(input);
  if (line === 'components') {
    if (data.componentLimit === undefined && data.limit !== undefined) data.componentLimit = data.limit;
    delete data.limit;
    if (data.componentLimit !== undefined && (!Number.isInteger(data.componentLimit) || Number(data.componentLimit) < 1 || Number(data.componentLimit) > 100)) invalid('componentLimit 必须是 1–100 的整数');
    if (data.componentUrls !== undefined) {
      if (!Array.isArray(data.componentUrls) || data.componentUrls.length > 1000) invalid('componentUrls 必须是最多 1000 个地址的数组');
      for (const address of data.componentUrls as unknown[]) {
        if (new URL(url(address, '组件页面')).origin !== new URL(source).origin) invalid('组件页面必须与来源同站');
      }
    }
  }
  if (line === 'sci-figure') {
    const figure = data.figure;
    if (!record(figure)) invalid('科研绘图需要 figure 中的真实数值或上游代码，不能只投网址');
    const value = figure as Record<string, unknown>;
    if (value.codeUrl) {
      url(value.codeUrl, '复现代码');
      if (typeof value.output !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*\.png$/.test(value.output)) invalid('代码复现须指定 output PNG 文件名');
      if (value.dataUrls !== undefined && (!Array.isArray(value.dataUrls) || value.dataUrls.length > 20)) invalid('dataUrls 最多 20 项');
      for (const address of (value.dataUrls ?? []) as unknown[]) url(address, '数据文件');
    } else {
      if (!['line', 'bar', 'scatter'].includes(String(value.kind ?? 'line'))) invalid('figure.kind 只支持 line、bar、scatter');
      if (!Array.isArray(value.series) || value.series.length < 1 || value.series.length > 30) invalid('figure.series 需要 1–30 组真实数据');
      for (const series of value.series as unknown[]) {
        if (!record(series) || !Array.isArray(series.x) || !Array.isArray(series.y) || series.x.length !== series.y.length || !series.x.length || series.x.length > 100000 ||
            [...series.x, ...series.y].some(number => typeof number !== 'number' || !Number.isFinite(number))) invalid('每组 x/y 必须等长非空，并且只包含有限数值');
      }
    }
    if (value.seed !== undefined && (!Number.isSafeInteger(value.seed) || Number(value.seed) < 0 || Number(value.seed) > 4294967295)) invalid('seed 必须是 0–4294967295 的整数');
  }
  if (line === 'image-fx') {
    if (!record(data.effect)) invalid('图像处理需要明确的 effect.kind 和真实原图');
    const effect = data.effect as Record<string, unknown>;
    if (!['grayscale', 'blur', 'contrast', 'edges', 'resize'].includes(String(effect.kind))) invalid('不支持该图像变换');
    effect.imageUrl = url(effect.imageUrl ?? source, '原图');
    const within = (field: string, min: number, max: number, integer = false) => {
      const value = effect[field];
      if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || integer && !Number.isInteger(value))) invalid(`effect.${field} 必须在 ${min}–${max} 之间${integer ? '且为整数' : ''}`);
    };
    within('radius', Number.MIN_VALUE, 100); within('factor', 0, 10); within('width', 1, 8192, true);
  }
  return data;
}

export function candidateRoute(source: string, data: Record<string, unknown>): BusinessLine | 'curation' {
  if (typeof data.route === 'string' && [...businessLines, 'curation'].includes(data.route)) return data.route as BusinessLine | 'curation';
  if (record(data.figure)) return 'sci-figure';
  if (record(data.effect)) return 'image-fx';
  if (Array.isArray(data.componentUrls)) return 'components';
  let pathname = '';
  try {pathname = decodeURIComponent(new URL(source).pathname);} catch {return 'curation';}
  if (/(?:^|\/)(?:DESIGN|SKILL)\.md$/i.test(pathname)) return 'skills';
  if (/\.pptx$/i.test(pathname)) return 'ppt';
  // A PDF may be a paper. Only an explicitly declared deck is routed as one.
  return 'curation';
}
