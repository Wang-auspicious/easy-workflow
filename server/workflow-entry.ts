import { Check, Errors } from 'typebox/value';
import type { WorkflowManifest } from './workflow-packs.ts';
import { workflowValue } from './workflow-packs.ts';
import { ControlError } from './errors.ts';

/** Manual input can start a declared pack or an independent line, never jump into
 * an arbitrary middle station and bypass its producers or review gates. */
export function workflowEntry(manifest: WorkflowManifest, input: Record<string,unknown>, lineId?: string) {
  let entry=manifest.entry,schema=manifest.schemas[manifest.inputSchema],value=input;
  if(lineId){
    const line=manifest.lines.find(item=>item.id===lineId);
    if(!line?.wired)throw new ControlError(404,'workflow_line_not_found','没有这条已接入的项目流水线');
    const qualify=(key:string)=>key.includes('/')?key:`${line.id}/${key}`;
    const edges=[...line.edges.map(edge=>({...edge,from:qualify(edge.from),to:qualify(edge.to)})),...manifest.links].filter(edge=>edge.kind!=='return'&&edge.kind!=='channel');
    const roots=line.stations.filter(node=>!edges.some(edge=>edge.to===`${line.id}/${node.id}`));
    if(roots.length!==1)throw new ControlError(422,'workflow_entry_ambiguous','独立流水线必须有唯一入口，不能绕过已有前驱工位投料');
    entry=`${line.id}/${roots[0].id}`;let bound=entry;
    const visited=new Set<string>();
    while(!manifest.bindings[bound]){
      if(visited.has(bound))throw new ControlError(422,'workflow_entry_missing','入口缺少执行契约');visited.add(bound);
      const next=edges.filter(edge=>edge.from===bound);
      if(next.length!==1)throw new ControlError(422,'workflow_entry_missing','入口缓冲区必须连接唯一的可执行输入工位');
      bound=next[0].to;
    }
    const binding=manifest.bindings[bound];
    schema=manifest.schemas[binding.inputSchema];
    value=Object.fromEntries(Object.entries(binding.input).map(([key,selector])=>[key,'value' in selector?selector.value:workflowValue({input},selector.path)??selector.default]).filter(([,v])=>v!==undefined));
  }
  if(!Check(schema,value))throw new ControlError(422,'workflow_input_invalid','输入不符合入口契约',[...Errors(schema,value)].slice(0,8).map(error=>({path:error.instancePath,message:error.message})));
  return entry;
}
