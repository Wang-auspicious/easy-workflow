import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {fileURLToPath} from "node:url";
const root=fileURLToPath(new URL("../packs/vislexicon/roles/",import.meta.url));

export function readRole(station:string) {
  if(!/^(dispatcher|[a-z0-9-]+\/[a-z0-9-]+)$/.test(station))throw new Error("无效 ROLE 节点标识");
  const file=path.join(root,station,"ROLE.md");
  if(!fs.existsSync(file))throw new Error(`工位 ${station} 缺少 ROLE.md，请先补齐职责和异常处理契约`);
  const content=fs.readFileSync(file,"utf8");
  return {station,path:`packs/vislexicon/roles/${station}/ROLE.md`,revision:crypto.createHash("sha256").update(content).digest("hex").slice(0,12),content};
}
