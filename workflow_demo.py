"""A small, runnable model of ZCode's phase/actor workflow."""

from __future__ import annotations

import argparse
import json
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from threading import Lock


WORKERS = (
    ("读图检验员", "读取项目结构"),
    ("编辑提交员", "检查可交付修改"),
    ("规范朗读员", "检查命名和文档"),
)
PHASE_NAMES = ("控制面资格化", "并行 worker 检查", "协调者收集验收", "哨兵巡查日志")


class Run:
    """The journal and phase state owned by one workflow run."""

    def __init__(self, fail: str | None, delay: float):
        self.fail, self.delay = fail, max(0.0, delay)
        self.started = time.perf_counter()
        self.lock = Lock()
        self.seq = 0
        self.events = []
        self.phases = [{"name": name, "state": "pending"} for name in PHASE_NAMES]

    def event(self, phase: str, actor: str, state: str, text: str, **data):
        with self.lock:
            self.seq += 1
            item = {
                "seq": self.seq,
                "at_ms": round((time.perf_counter() - self.started) * 1000),
                "phase": phase,
                "actor": actor,
                "state": state,
                "text": text,
                **data,
            }
            self.events.append(item)
            return item

    def phase(self, index: int, state: str, actor: str, text: str):
        self.phases[index]["state"] = state
        return self.event(self.phases[index]["name"], actor, state, text)


def ask(run: Run, phase: str, name: str, task: str) -> dict:
    """One actor ask: running -> structured result -> terminal journal event."""
    run.event(phase, name, "running", task)
    time.sleep(run.delay)
    if run.fail == name:
        error = {"actor": name, "ok": False, "error": "worker 被注入失败", "task": task}
        run.event(phase, name, "failed", error["error"], result=error)
        return error
    result = {"actor": name, "ok": True, "finding": task + "完成", "task": task}
    run.event(phase, name, "done", result["finding"], result=result)
    return result


def audit(run: Run, results: dict[str, dict]) -> dict:
    """Sentinel checks the journal, without inferring missing worker state."""
    expected = list(range(1, len(run.events) + 1))
    actual = [event["seq"] for event in run.events]
    terminal = {
        event["actor"]
        for event in run.events
        if event["state"] in {"done", "failed"} and event["actor"] in results
    }
    missing = sorted(set(results) - terminal)
    ok = actual == expected and not missing and len(results) == len(WORKERS)
    return {"ok": ok, "events": len(run.events), "missing_workers": missing,
            "message": "事件连续，worker 结果齐全" if ok else "事件或 worker 结果不完整"}


def run_workflow(fail: str | None = None, delay: float = 0.05) -> dict:
    run = Run(fail, delay)
    run.phase(0, "running", "协调者", "检查输入、阶段表和运行权限")
    time.sleep(run.delay)
    run.phase(0, "done", "协调者", "控制面可运行")

    fanout = run.phases[1]["name"]
    run.phase(1, "running", "协调者", "提交三个独立 actor ask")
    results = {}
    with ThreadPoolExecutor(max_workers=len(WORKERS)) as pool:
        futures = {pool.submit(ask, run, fanout, name, task): name for name, task in WORKERS}
        for future in as_completed(futures):
            result = future.result()
            results[result["actor"]] = result
    all_ok = all(result["ok"] for result in results.values())
    run.phase(1, "done" if all_ok else "failed", "协调者",
              "三个 worker 均返回" if all_ok else "保留已完成结果，停止进入汇总")

    join = run.phases[2]["name"]
    if all_ok:
        run.phase(2, "running", "收集协调者", "只读取三个结构化结果")
        summary = {"accepted": True, "worker_count": len(results),
                   "findings": [results[name]["finding"] for name, _ in WORKERS]}
        run.event(join, "收集协调者", "done", "验收通过", result=summary)
        run.phases[2]["state"] = "done"
    else:
        summary = {"accepted": False, "worker_count": len(results), "findings": list(results.values())}
        run.phase(2, "failed", "收集协调者", "worker 失败，汇总被阻断")

    sentinel_name = run.phases[3]["name"]
    run.phase(3, "running", "哨兵", "检查阶段顺序、事件序号和结果完整性")
    report = audit(run, results)
    run.event(sentinel_name, "哨兵", "done" if report["ok"] else "failed", report["message"], result=report)
    run.phases[3]["state"] = "done" if report["ok"] else "failed"
    status = "done" if all_ok and report["ok"] else "failed"
    return {"status": status, "stopped_at": None if status == "done" else fanout,
            "phases": run.phases, "workers": [results[name] for name, _ in WORKERS],
            "coordinator": summary, "sentinel": report, "events": run.events}


def main():
    parser = argparse.ArgumentParser(description="Run the H2 Agent Team workflow demo.")
    parser.add_argument("--fail", choices=[name for name, _ in WORKERS], help="inject one worker failure")
    parser.add_argument("--delay", type=float, default=0.05, help="worker delay in seconds")
    parser.add_argument("--output", type=Path, default=Path("run.json"))
    args = parser.parse_args()
    result = run_workflow(args.fail, args.delay)
    args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "done" else 1


if __name__ == "__main__":
    raise SystemExit(main())
