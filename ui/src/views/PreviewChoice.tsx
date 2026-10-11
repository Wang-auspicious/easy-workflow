import { useState } from "react";
import { api } from "../api.ts";
import "./preview-choice.css";

export function PreviewChoice({item,station,onMessage}:{item:string;station?:string;onMessage:(message:string)=>void}){
  const [role,setRole]=useState(station==="curation/breadth"?"breadth":"proof");
  const [url,setURL]=useState("");const [busy,setBusy]=useState(false);
  return <details className="preview-choice"><summary>指定目录或示例页后继续</summary>
    <form onSubmit={async e=>{e.preventDefault();setBusy(true);try{
      await api.post("/api/tools/choose_preview_page",{item,role,url});
      onMessage("已指定页面，从对应工位继续；已有成果保留。");
    }catch(error){onMessage((error as Error).message);}finally{setBusy(false);}}}>
      <select aria-label="采集页用途" value={role} onChange={e=>setRole(e.target.value)}><option value="breadth">目录 / 总览</option><option value="proof">示例 / 特写</option></select>
      <input aria-label="采集页面网址" type="url" required placeholder="https://…" value={url} onChange={e=>setURL(e.target.value)}/>
      <button className="btn btn--sm" disabled={busy||!url}>{busy?"正在继续…":"按这页继续"}</button>
    </form>
  </details>;
}
