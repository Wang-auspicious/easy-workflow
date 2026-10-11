"""Runnable ZCode-style software-engineering workflow."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock

from workflow_spec import PHASES, actor_map, all_actors, graph_template


# Compatibility aliases keep the first H2 demo's public surface usable.
ACTORS = actor_map()
WORKERS = tuple((actor.name, actor.task) for actor in PHASES[1].actors)
PHASE_NAMES = tuple(phase.name for phase in PHASES)
COORDINATOR_ID = "coordinator"


class Run:
    """One run owns its journal, status overlay, and structured results."""

    def __init__(self, fail: str | None = None, delay: float = 0.05):
        names = {actor.name: actor.id for actor in all_actors()}
        self.fail = names.get(fail, fail)
        self.delay = max(0.0, delay)
        self.started = time.perf_counter()
        self.lock = Lock()
        self.seq = 0
        self.events: list[dict] = []
        self.phase_states = {phase.id: "pending" for phase in PHASES}
        self.actor_states = {actor.id: "pending" for actor in all_actors()}
        self.results: dict[str, dict] = {}
        self.blocked_by: dict[str, str] = {}

    def _phase(self, phase_id: str | None) -> tuple[str, str]:
        for phase in PHASES:
            if phase.id == phase_id:
                return phase.id, phase.name
        return phase_id or "runtime", "运行结算"

    def _actor(self, actor_id: str) -> str:
        if actor_id == COORDINATOR_ID:
            return "协调者"
        if actor_id == "sentinel":
            return "哨兵"
        return ACTORS[actor_id].name if actor_id in ACTORS else actor_id

    def event(self, phase_id: str | None, actor_id: str, state: str, text: str, *, kind: str = "actor", **data):
        with self.lock:
            self.seq += 1
            phase_key, phase_name = self._phase(phase_id)
            item = {
                "seq": self.seq,
                "at_ms": round((time.perf_counter() - self.started) * 1000),
                "phase_id": phase_key,
                "phase": phase_name,
                "actor_id": actor_id,
                "actor": self._actor(actor_id),
                "state": state,
                "kind": kind,
                "text": text,
                **data,
            }
            self.events.append(item)
            if actor_id in self.actor_states and state in {"running", "done", "failed"}:
                self.actor_states[actor_id] = state
            return item

    def phase_event(self, phase_id: str, state: str, text: str):
        self.phase_states[phase_id] = state
        return self.event(phase_id, COORDINATOR_ID, state, text, kind="phase")

    def save_result(self, actor_id: str, result: dict):
        with self.lock:
            self.results[actor_id] = result

    def phase_rows(self) -> list[dict]:
        return [
            {
                "id": phase.id,
                "name": phase.name,
                "discipline": phase.discipline,
                "state": self.phase_states[phase.id],
                "blocked_by": self.blocked_by.get(phase.id),
                "actors": [
                    {"id": actor.id, "name": actor.name, "role": actor.role, "state": self.actor_states[actor.id]}
                    for actor in phase.actors
                ],
            }
            for phase in PHASES
        ]


def ask(run: Run, phase_id: str, actor_id: str) -> dict:
    """Execute one named actor and always settle it with a structured result."""
    actor = ACTORS[actor_id]
    run.event(phase_id, actor_id, "running", actor.task)
    time.sleep(run.delay)
    if run.fail == actor_id:
        result = {
            "actor_id": actor.id,
            "actor": actor.name,
            "role": actor.role,
            "phase_id": phase_id,
            "ok": False,
            "task": actor.task,
            "error": "actor 被注入失败",
        }
        run.save_result(actor_id, result)
        run.event(phase_id, actor_id, "failed", result["error"], result=result)
        return result
    result = {
        "actor_id": actor.id,
        "actor": actor.name,
        "role": actor.role,
        "phase_id": phase_id,
        "ok": True,
        "task": actor.task,
        "artifact": {
            "kind": "workflow-finding",
            "summary": f"{actor.task}完成",
            "source": "H2 demo actor",
        },
    }
    run.save_result(actor_id, result)
    run.event(phase_id, actor_id, "done", result["artifact"]["summary"], result=result)
    return result


def _run_phase(run: Run, phase) -> tuple[bool, list[dict]]:
    run.phase_event(phase.id, "running", f"进入 {phase.discipline} 阶段")
    actor_ids = [actor.id for actor in phase.actors]
    if phase.fanout:
        run.event(phase.id, COORDINATOR_ID, "running", f"并行提交 {len(actor_ids)} 个 actor ask", kind="coordination")
        with ThreadPoolExecutor(max_workers=len(actor_ids)) as pool:
            futures = {pool.submit(ask, run, phase.id, actor_id): actor_id for actor_id in actor_ids}
            results = [future.result() for future in as_completed(futures)]
    else:
        results = [ask(run, phase.id, actor_ids[0])]
    all_ok = all(result["ok"] for result in results)
    run.phase_event(phase.id, "done" if all_ok else "failed",
                    "阶段结果齐全" if all_ok else "保留已完成结果，阻断后续阶段")
    if phase.fanout:
        join = {
            "phase_id": phase.id,
            "accepted": all_ok,
            "actor_count": len(results),
            "results": results,
        }
        run.event(phase.id, COORDINATOR_ID, "done" if all_ok else "failed",
                  "结构化结果已汇总" if all_ok else "汇总被阻断", kind="coordination", result=join)
    return all_ok, results


def audit(run: Run) -> dict:
    """Validate journal invariants without inventing missing actor state."""
    expected = list(range(1, len(run.events) + 1))
    actual = [event["seq"] for event in run.events]
    executed = {event["actor_id"] for event in run.events if event["actor_id"] in run.actor_states}
    terminal = {
        event["actor_id"]
        for event in run.events
        if event["actor_id"] in run.actor_states and event["state"] in {"done", "failed"}
    }
    missing = sorted(executed - terminal)
    graph_ids = [node["id"] for node in graph_template()["nodes"]]
    graph_stable = len(graph_ids) == len(set(graph_ids))
    ok = actual == expected and not missing and graph_stable
    return {
        "ok": ok,
        "events": len(run.events),
        "executed_actors": sorted(executed),
        "missing_terminal_actors": missing,
        "graph_stable": graph_stable,
        "message": "事件连续、actor 终态齐全、图拓扑稳定" if ok else "事件或 actor 终态不完整",
    }


def project_graph(run: Run) -> dict:
    """Overlay live state on a topology that never changes during a run."""
    graph = graph_template()
    for node in graph["nodes"]:
        if node["kind"] == "phase":
            node["state"] = run.phase_states[node["id"].split(":", 1)[1]]
        else:
            node["state"] = run.actor_states[node["id"].split(":", 1)[1]]
    graph["statuses"] = {
        "phases": dict(run.phase_states),
        "actors": dict(run.actor_states),
    }
    graph["animated_edges"] = [
        edge["id"]
        for edge in graph["edges"]
        if edge["kind"] == "handoff"
        and run.phase_states[edge["target"].split(":", 1)[1]] == "running"
    ]
    return graph


def run_workflow(fail: str | None = None, delay: float = 0.05) -> dict:
    run = Run(fail, delay)
    stopped_at = None
    for index, phase in enumerate(PHASES):
        ok, _ = _run_phase(run, phase)
        if not ok:
            stopped_at = phase
            for later in PHASES[index + 1:]:
                run.blocked_by[later.id] = phase.id
            break

    run.event(None, "sentinel", "running", "检查事件序号、actor 终态和图拓扑", kind="audit")
    report = audit(run)
    run.event(None, "sentinel", "done" if report["ok"] else "failed", report["message"], kind="audit", result=report)
    success = stopped_at is None and report["ok"]
    ordered_results = [run.results[actor.id] for actor in all_actors() if actor.id in run.results]
    findings = [
        result.get("artifact", {}).get("summary", result.get("error"))
        for result in ordered_results
    ]
    return {
        "workflow_id": "software-engineering-review",
        "status": "done" if success else "failed",
        "stopped_at": stopped_at.name if stopped_at else None,
        "stopped_at_id": stopped_at.id if stopped_at else None,
        "phases": run.phase_rows(),
        "actors": ordered_results,
        "coordinator": {"accepted": success, "actor_count": len(ordered_results), "findings": findings},
        "sentinel": report,
        "graph": project_graph(run),
        "events": run.events,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run the H2 software-engineering agent workflow.")
    choices = [actor.name for actor in all_actors()] + [actor.id for actor in all_actors()]
    parser.add_argument("--fail", choices=choices, help="inject one actor failure")
    parser.add_argument("--delay", type=float, default=0.05, help="actor delay in seconds")
    parser.add_argument("--output", type=Path, default=Path("run.json"))
    args = parser.parse_args()
    result = run_workflow(args.fail, args.delay)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
