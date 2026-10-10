import { useSyncExternalStore } from "react";

interface Toast { id: number; text: string; action?: { label: string; run: () => void }; ttl: number }
let toasts: Toast[] = [];
const ls = new Set<() => void>();
const emit = () => { for (const l of ls) l(); };

export function toast(text: string, action?: Toast["action"], ttl = 4200) {
  const t = { id: Date.now() + Math.random(), text, action, ttl };
  toasts = [...toasts.slice(-2), t];
  emit();
  setTimeout(() => { toasts = toasts.filter((x) => x.id !== t.id); emit(); }, ttl);
}

export function Toasts() {
  const list = useSyncExternalStore((l) => { ls.add(l); return () => ls.delete(l); }, () => toasts);
  const last = list[list.length - 1];
  if (!last) return null;
  return (
    <div className="toast" key={last.id}>
      <span>{last.text}</span>
      {last.action && <button className="btn btn--sm" onClick={() => { last.action!.run(); toasts = toasts.filter((x) => x.id !== last.id); emit(); }}>{last.action.label}</button>}
    </div>
  );
}
