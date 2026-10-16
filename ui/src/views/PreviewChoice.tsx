import {useRef, useState} from 'react';
import { api } from "../api.ts";
import {getState, useStore} from '../store.ts';
import "./preview-choice.css";

export function PreviewChoice({item,station,onMessage}:{item:string;station?:string;onMessage:(message:string)=>void}){
  const [role,setRole]=useState(station==="curation/breadth"?"breadth":"proof");
  const [url,setURL]=useState("");const [busy,setBusy]=useState(false);
  const flight = useRef(false);
  const disabled = useStore(state => !state.connected || Boolean(state.replay));
  const [error, setError] = useState('');
  return <details className="preview-choice"><summary>指定目录或示例页后继续</summary>
    <form onSubmit={async e=>{e.preventDefault();if(flight.current || !getState().connected || getState().replay)return;flight.current=true;setBusy(true);setError('');try{
      const response = await api.post<{ok: boolean; error?: string; summary?: string}>("/api/tools/choose_preview_page",{item,role,url: url.trim()});
      if (!response.ok) throw new Error(response.error ?? response.summary ?? '页面选择未成功，请核对后重试。');
      onMessage("已指定页面，从对应工位继续；已有成果保留。");
    }catch(error){setError(error instanceof Error ? error.message : '指定页面失败');}finally{flight.current=false;setBusy(false);}}}>
      <select aria-label="采集页用途" value={role} onChange={e=>setRole(e.target.value)}><option value="breadth">目录 / 总览</option><option value="proof">示例 / 特写</option></select>
      <input aria-label="采集页面网址" type="url" required placeholder="https://…" value={url} onChange={e=>setURL(e.target.value)}/>
      <button className="btn btn--sm" disabled={disabled||busy||!url.trim()}>{busy?"正在继续…":"按这页继续"}</button>
    </form>
    {error && <p role="alert">{error}</p>}
  </details>;
}
