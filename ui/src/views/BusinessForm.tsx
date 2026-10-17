import {useRef, useState} from 'react';
import { Loader2, Play, X } from 'lucide-react';
import { parseObject, workflowCall } from './workflows.ts';
import {getState} from '../store.ts';

export const businessLines = ['components', 'skills', 'sci-figure', 'ppt', 'image-fx'] as const;
export type BusinessLine = typeof businessLines[number];
const descriptions: Record<BusinessLine, string> = {
  components: '读取网站中的组件，采集页面与组件证据，再审查可复用性。可指定组件页面；留空时由页面链接发现。',
  skills: '保存 SKILL.md / DESIGN.md 原件，核对出处与许可，再生成简介并审查。原始文件保持字节不变。',
  'sci-figure': '使用你提供的真实数值绘制科研图，保存输入、生成文件和审查记录。',
  ppt: '保存直接下载地址中的完整 PPTX 或 PDF 演示文件，逐页生成预览并审查。',
  'image-fx': '下载指定原图，执行明确的图像变换，保留原图、参数与结果。',
};
const figureExample = '{\n  "kind": "line",\n  "series": [{ "x": [1, 2], "y": [3, 5], "label": "替换为真实数据" }],\n  "title": "实验标题",\n  "xLabel": "横轴",\n  "yLabel": "纵轴",\n  "seed": 42\n}';

export function BusinessForm({ line, title, disabled, onBusy, onClose, onDone }: {
  line: BusinessLine; title: string; disabled: boolean; onBusy: (busy: boolean) => void;
  onClose: () => void; onDone: (message: string) => Promise<void>;
}) {
  const [item, setItem] = useState(''), [url, setUrl] = useState(''), [json, setJson] = useState('');
  const [componentUrls, setComponentUrls] = useState(''), [limit, setLimit] = useState('');
  const [effect, setEffect] = useState('grayscale'), [parameter, setParameter] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const flight = useRef(false);
  const submit = async (event: React.FormEvent) => {
    event.preventDefault(); if (flight.current || disabled || !getState().connected || getState().replay) return;
    flight.current = true;
    setBusy(true); onBusy(true); setError('');
    try {
      if (!item.trim()) throw new Error('请填写任务名称，不能仅包含空格。');
      const data: Record<string, unknown> = {};
      if (line === 'sci-figure') data.figure = parseObject(json, '科研图数据');
      if (line === 'components') {
        const pages = componentUrls.split(/\r?\n/).map(value => value.trim()).filter(Boolean);
        if (pages.length) data.componentUrls = pages;
        if (limit) data.componentLimit = Number(limit);
      }
      if (line === 'image-fx') {
        const options: Record<string, unknown> = { kind: effect, imageUrl: url.trim() };
        const key = effect === 'blur' ? 'radius' : effect === 'contrast' ? 'factor' : effect === 'resize' ? 'width' : undefined;
        if (key && parameter.trim()) options[key] = Number(parameter);
        data.effect = options;
      }
      const response = await workflowCall('business_feed', { line, item: item.trim(), url: url.trim(), ...(Object.keys(data).length ? { data } : {}) });
      await onDone(response.summary ?? '任务已投入流水线，可在画布和证据墙追踪。');
    } catch (reason) { setError((reason as Error).message); }
    finally { flight.current = false; setBusy(false); onBusy(false); }
  };
  return <form className="workflow-form" aria-label={`提交任务 · ${title}`} onSubmit={event => void submit(event)}>
    <div className="workflow-form-head"><h2>提交任务 · {title}</h2><button type="button" className="icon-btn" disabled={busy} aria-label="关闭业务任务表单" onClick={onClose}><X size={15} /></button></div>
    <fieldset disabled={disabled || busy} style={{display: 'contents'}}>
    <p>{descriptions[line]}</p>
    <label>任务名称<input autoFocus required value={item} maxLength={160} onChange={event => setItem(event.target.value)} placeholder="这次任务的可追踪名称" /></label>
    <label>{line === 'image-fx' ? '原图地址' : line === 'sci-figure' ? '数据来源地址' : '来源网页地址'}<input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder={line === 'image-fx' ? 'https://…/original.png' : 'https://…'} /><small>{line === 'sci-figure' ? '填写实验、数据集或论文的来源；图中的数值由下方数据决定。' : '填写可公开访问的完整地址。'}</small></label>
    {line === 'components' && <><label>指定组件页面（可选，每行一个地址）<textarea rows={3} value={componentUrls} onChange={event => setComponentUrls(event.target.value)} placeholder="https://…/components/button" /></label><label>最多采集组件数（可选）<input type="number" min={1} max={12} step={1} value={limit} onChange={event => setLimit(event.target.value)} placeholder="采用流水线默认值" /></label></>}
    {line === 'sci-figure' && <label>科研图数据（JSON）<textarea required rows={10} spellCheck={false} value={json} onChange={event => setJson(event.target.value)} placeholder={figureExample} /><small>kind 支持 line、bar、scatter；每组 x 与 y 长度一致。示例仅说明格式，请填写真实数值。可提供 seed、title、xLabel、yLabel。</small></label>}
    {line === 'image-fx' && <><label>图像变换<select value={effect} onChange={event => { setEffect(event.target.value); setParameter(''); }}><option value="grayscale">灰度</option><option value="blur">模糊</option><option value="contrast">对比度</option><option value="edges">边缘提取</option><option value="resize">调整宽度</option></select></label>{['blur', 'contrast', 'resize'].includes(effect) && <label>{effect === 'blur' ? '模糊半径（可选）' : effect === 'contrast' ? '对比度系数（可选）' : '输出宽度（像素）'}<input type="number" required={effect === 'resize'} min={effect === 'resize' ? 1 : 0} step={effect === 'resize' ? 1 : 0.1} value={parameter} onChange={event => setParameter(event.target.value)} placeholder={effect === 'resize' ? '例如 1280' : '采用默认参数'} /></label>}</>}
    </fieldset>
    {error && <p className="workflow-error" role="alert">{error}</p>}
    <div className="workflow-form-actions"><button type="button" className="btn btn--sm" disabled={busy} onClick={onClose}>取消</button><button className="btn btn--sm btn--primary" disabled={busy || disabled}>{busy ? <Loader2 size={13} className="spin-i" /> : <Play size={13} />}{busy ? '正在投料…' : '验证输入并投料'}</button></div>
  </form>;
}
