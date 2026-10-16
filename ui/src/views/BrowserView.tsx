import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowRight, RotateCw, Plus, X, Star, History, Globe, AlertCircle } from "lucide-react";
import { actions } from "../api.ts";
import {getState, useStore} from '../store.ts';
import "./browser.css";

type DesktopBrowser = { browserBounds(bounds: {x:number;y:number;width:number;height:number} | null): Promise<void> };
const desktop = (window as unknown as {desktop?:DesktopBrowser}).desktop;
const normalize = (s:string) => /^https?:\/\//i.test(s) ? s : `https://${s}`;

export function BrowserView() {
  const browser = useStore(s => s.browser);
  const readOnly = useStore(state => !state.connected || Boolean(state.replay));
  const replay = useStore(state => Boolean(state.replay));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const flight = useRef(false);
  const active = browser.tabs.find(t => t.id === browser.active);
  const [url,setURL] = useState("");
  const [history,setHistory] = useState(false);
  const [adding,setAdding] = useState(false);
  const [label,setLabel] = useState("");
  const [bookmarkURL,setBookmarkURL] = useState("");
  const [editing,setEditing]=useState<string|null>(null),[bookmarkMenu,setBookmarkMenu]=useState<{id:string;x:number;y:number}|null>(null);
  const editBookmark=(id:string)=>{const b=browser.bookmarks.find(b=>b.id===id);if(!b)return;setEditing(id);setLabel(b.title);setBookmarkURL(b.url);setAdding(true);setBookmarkMenu(null);};
  useEffect(()=>{if(!adding)setEditing(null);},[adding]);
  useEffect(()=>{if(!bookmarkMenu)return;const dismiss=()=>setBookmarkMenu(null),key=(e:KeyboardEvent)=>{if(e.key==="Escape")dismiss();};window.addEventListener("click",dismiss);window.addEventListener("keydown",key);return()=>{window.removeEventListener("click",dismiss);window.removeEventListener("keydown",key);};},[bookmarkMenu]);
  const slot = useRef<HTMLDivElement>(null);
  const run = async (action: string, extra: Record<string, unknown> = {}) => {
    if (flight.current || !getState().connected || getState().replay) return false;
    flight.current = true;
    setBusy(true);
    setError('');
    try {
      await actions.browser({action, id: active?.id, ...extra});
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '浏览器操作失败，请检查连接后重试。');
      return false;
    } finally {
      flight.current = false;
      setBusy(false);
    }
  };
  useEffect(() => { setURL(active?.url.startsWith("about:") ? "" : active?.url ?? ""); },[active?.id,active?.url]);
  const blank = !active || active.url.startsWith("about:");
  useLayoutEffect(() => {
    const el = slot.current; if (!desktop || !el) return;
    const sync = () => { const r = el.getBoundingClientRect(); void desktop.browserBounds(readOnly || history || blank || Boolean(bookmarkMenu) ? null : {x:r.x,y:r.y,width:r.width,height:r.height}); };
    const observer = new ResizeObserver(sync); observer.observe(el); window.addEventListener("resize",sync); sync();
    return () => { observer.disconnect(); window.removeEventListener("resize",sync); void desktop.browserBounds(null); };
  },[history,blank,active?.id,bookmarkMenu,readOnly]);
  const needs = browser.tabs.filter(t => t.attention);
  return <div className="view browser-workspace">
    {readOnly && <p role="status" className="browser-attention">{replay ? '回放为只读，退出回放后可操作浏览器。' : '连接恢复后可操作浏览器，当前页面与输入已保留。'}</p>}
    {error && <p role="alert" className="browser-attention">{error}</p>}
    <fieldset disabled={readOnly || busy} style={{display: 'contents'}}>
    <div className="browser-tabs" role="tablist" aria-label="浏览器标签页">
      {browser.tabs.map(t => <div key={t.id} draggable onDragStart={e=>e.dataTransfer.setData("h2-tab",t.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData("h2-tab");if(id&&id!==t.id)run("tab.move",{id,before:t.id});}} className={`browser-tab ${t.id === active?.id ? "is-active" : ""}`}>
        <button role="tab" aria-selected={t.id === active?.id} onClick={() => {setHistory(false);run("activate",{id:t.id});}}><span className={`tab-dot ${t.attention ? "has-attention" : t.loading ? "is-loading" : ""}`} /><span>{t.title}</span>{t.owner === "agent" && <small>任务</small>}</button>
        <button aria-label={`关闭 ${t.title}`} className="tab-close" onClick={() => run("close",{id:t.id})}><X size={12}/></button>
      </div>)}
      <button className="icon-btn" aria-label="新建标签页" onClick={() => {setHistory(false);run("open");}}><Plus size={15}/></button>
    </div>
    <div className="browser-address">
      <button className="icon-btn" aria-label="后退" disabled={!active?.canGoBack} onClick={() => run("back")}><ArrowLeft size={16}/></button>
      <button className="icon-btn" aria-label="前进" disabled={!active?.canGoForward} onClick={() => run("forward")}><ArrowRight size={16}/></button>
      <button className="icon-btn" aria-label="刷新网页" disabled={!active} onClick={() => run("reload")}><RotateCw size={14}/></button>
      <form onSubmit={e => {e.preventDefault();setHistory(false);if(url.trim()) run(active ? "navigate" : "open",{url:normalize(url.trim())});}}><Globe size={13}/><input aria-label="网址" placeholder="输入网址" value={url} onChange={e=>setURL(e.target.value)}/></form>
      <button className="icon-btn" aria-label="添加收藏" onClick={() => {setEditing(null);setAdding(!adding);setLabel(active?.title || "");setBookmarkURL(url);}}><Star size={15}/></button>
      <button className={`icon-btn ${history ? "is-on" : ""}`} aria-label="浏览历史" onClick={() => setHistory(!history)}><History size={15}/></button>
    </div>
    <div className="browser-bookmarks">
      {browser.bookmarks.map(b => <button key={b.id} draggable onDragStart={e=>e.dataTransfer.setData("h2-bookmark",b.id)} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();const id=e.dataTransfer.getData("h2-bookmark");if(id)run("bookmark.move",{id,before:b.id});}} onClick={()=>{setHistory(false);run(active ? "navigate":"open",{url:b.url});}} onContextMenu={e=>{e.preventDefault();setBookmarkMenu({id:b.id,x:Math.min(e.clientX,innerWidth-170),y:e.clientY});}} onKeyDown={e=>{if(e.key==="ContextMenu"||(e.shiftKey&&e.key==="F10")){e.preventDefault();const r=e.currentTarget.getBoundingClientRect();setBookmarkMenu({id:b.id,x:r.left,y:r.bottom});}}} title={`${b.url} · 右键编辑或删除 · 拖动排序`}><span>{b.title}</span></button>)}
      <button className="bookmark-add" aria-label="自定义收藏" onClick={()=>{setEditing(null);setAdding(!adding);setLabel("");setBookmarkURL("");}}><Plus size={12}/></button>
    </div>
    {bookmarkMenu&&<div className="bookmark-context" role="menu" style={{left:bookmarkMenu.x,top:bookmarkMenu.y}}><button role="menuitem" onClick={()=>editBookmark(bookmarkMenu.id)}>编辑名称与网址</button><button role="menuitem" onClick={()=>{run("bookmark.remove",{id:bookmarkMenu.id});setBookmarkMenu(null);}}>删除收藏</button></div>}
    {adding && <form className="bookmark-form" onSubmit={e=>{e.preventDefault();if(bookmarkURL.trim())void run(editing ? 'bookmark.update' : 'bookmark.add', {...(editing?{id:editing}:{}),url:normalize(bookmarkURL.trim()),title:label.trim()}).then(saved=>{if(saved)setAdding(false);});}}><input aria-label="收藏名称" placeholder="名称" value={label} onChange={e=>setLabel(e.target.value)}/><input aria-label="收藏网址" required placeholder="https://" value={bookmarkURL} onChange={e=>setBookmarkURL(e.target.value)}/><button className="btn btn--sm" type="submit">{busy ? '正在保存…' : '保存'}</button><button className="icon-btn" type="button" aria-label="取消收藏" onClick={()=>setAdding(false)}><X size={13}/></button></form>}
    {needs.length>0 && <div className="browser-attention"><AlertCircle size={14}/><span>{active?.attention || `${needs.length} 个页面需要检查`}</span>{needs.filter(t=>t.id!==active?.id).map(t=><button key={t.id} onClick={()=>{setHistory(false);run("activate",{id:t.id});}}>{t.title}</button>)}<button onClick={()=>run("attention.check")}>重新检查</button></div>}
    <div className="browser-viewport" ref={slot}>
      {history ? <div className="browser-history"><div className="history-head"><h2>浏览历史</h2><label>保留 <select aria-label="历史保留天数" value={browser.retentionDays} onChange={e=>run("history.prune",{days:Number(e.target.value)})}>{[7,30,90].map(d=><option key={d} value={d}>{d} 天</option>)}</select></label></div><p>自动清理过期历史，不清除登录状态。</p>{browser.history.length ? browser.history.map((h,i)=><button key={`${h.at}-${i}`} onClick={()=>{setHistory(false);run("open",{url:h.url});}}><b>{h.title || new URL(h.url).hostname}</b><span>{h.url}</span><time>{new Date(h.at).toLocaleString("zh-CN",{month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit"})}</time></button>):<div className="browser-empty">还没有浏览记录</div>}</div>
        : blank ? <div className="browser-empty"><Globe size={30}/><h2>工作浏览器</h2><p>打开收藏或输入网址。后台任务的网页也会出现在这里。</p><div>{browser.bookmarks.map(b=><button key={b.id} onClick={()=>run(active?"navigate":"open",{url:b.url})}>{b.title}</button>)}</div></div>
        : !desktop ? <div className="browser-empty"><Globe size={28}/><h2>{active?.title}</h2><p>此页运行在独立服务的浏览器中。桌面应用支持直接查看和登录。</p></div> : null}
    </div>
    </fieldset>
  </div>;
}
