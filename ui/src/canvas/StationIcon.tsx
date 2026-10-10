import { Globe2, Database, Inbox, GitBranch, ScanLine, SlidersHorizontal, PenLine, ShieldCheck, FileCheck2, ArrowUpRight, Network, Search, Layers3, Command, type LucideIcon } from "lucide-react";
import type { Role } from "../../../shared/types.ts";

const icons: Record<Role | "dispatcher", LucideIcon> = {
  source: Globe2, social: Globe2, candidate: Inbox, sort: GitBranch, judge: Search,
  capture: ScanLine, process: SlidersHorizontal, write: PenLine, verify: ShieldCheck,
  review: FileCheck2, arbiter: GitBranch, publish: ArrowUpRight, channel: Network, store: Database,
  dispatcher: Command,
};

/** A quiet, consistent glyph; live state is communicated separately by the status dot. */
export function StationIcon({ role, size = 18, className = "" }: { role: Role | "dispatcher"; size?: number; className?: string }) {
  const Icon = icons[role] ?? Layers3;
  return <span className={`station-icon ${className}`} data-role={role}><Icon size={size} strokeWidth={1.7} aria-hidden="true" /></span>;
}
