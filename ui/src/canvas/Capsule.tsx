// A collapsed line (Spec §6.1.1): name, light, a dot per station, items in flight. Click opens it.
import type { Placed } from "../../../shared/layout.ts";
import { roleColors } from "../../../shared/palette.ts";
import { getState, useStore } from "../store.ts";
import { fmt } from "./Node.tsx";

export function Capsule({ line, place }: { line: string; place: Placed }) {
  useStore((s) => s.version);
  const s = getState();
  const l = s.factory!.lines.find((x) => x.id === line)!;
  const nodes = s.factory!.nodes.filter((n) => n.line === line);
  const inFlightItems = new Set(nodes.flatMap(node => [...(s.fs.nodes[node.key]?.queue ?? []), ...(s.fs.nodes[node.key]?.active ?? []).map(id => s.fs.attempts[id]?.token).filter(Boolean)]));
  const inflight = inFlightItems.size;
  const active = nodes.some(node => s.fs.nodes[node.key]?.active.length);
  const paused = s.fs.run.status === 'paused' || s.fs.pausedScopes?.lines.includes(line) || nodes.filter(node => s.fs.nodes[node.key]?.queue.length).length > 0 && nodes.filter(node => s.fs.nodes[node.key]?.queue.length).every(node => s.fs.pausedScopes?.stations.includes(node.key));
  const inbox = s.fs.nodes[`${line}/inbox`]?.stock ?? 0;
  const c = roleColors(nodes[1]?.role ?? "process");
  return (
    <div className={`capsule ${l.wired ? "" : "is-unwired"}`} data-capsule={line} style={{ left: place.x, top: place.y, width: place.w, height: place.h, ["--c" as string]: c.border, ["--fill" as string]: c.fill, ["--ink-c" as string]: c.ink }}
      data-tip={`${l.name}：${l.blurb}（点开展开）`}>
      <span className="capsule-name">{l.name}</span>
      <span className="capsule-row">
        {/* One dot per station in the role's colour: a glimpse of the folded DAG. */}
        <span className="capsule-dots" aria-hidden>{nodes.map((n) => <i key={n.key} style={{ background: roleColors(n.role).border }} className={s.fs.nodes[n.key]?.active.length ? "is-busy" : ""} />)}</span>
        {inbox || inflight ? <span className="capsule-meta num">{inbox ? `收件箱 ${fmt(inbox)}` : ""}{inbox && inflight ? " · " : ""}{inflight ? `在途 ${inflight}` : ""}</span> : null}
      </span>
      <i className={`light ${!l.wired ? 'light--gray' : paused ? 'light--yellow' : active ? 'light--green is-pulse' : inflight ? 'light--yellow' : 'light--idle'}`} />
    </div>
  );
}
