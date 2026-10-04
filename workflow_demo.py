import json
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path


def event(log, phase, actor, state, text):
    log.append({"time": round(time.time(), 3), "phase": phase, "actor": actor, "state": state, "text": text})


def worker(name, phase, task, log):
    event(log, phase, name, "running", task)
    time.sleep(0.15)
    result = {"actor": name, "ok": True, "finding": task + "完成"}
    event(log, phase, name, "done", result["finding"])
    return result


def run():
    log = []
    phases = [
        {"name": "控制面资格化", "state": "pending", "actors": ["脚本"]},
        {"name": "三个 worker 并行检查", "state": "pending", "actors": ["读图检验员", "编辑提交员", "规范朗读员"]},
        {"name": "协调者收集验收", "state": "pending", "actors": ["收集协调者"]},
        {"name": "哨兵巡查日志", "state": "pending", "actors": ["哨兵·日志巡查员"]},
    ]

    phases[0]["state"] = "running"
    event(log, phases[0]["name"], "脚本", "running", "检查输入和运行权限")
    time.sleep(0.15)
    phases[0]["state"] = "done"
    event(log, phases[0]["name"], "脚本", "done", "控制面可运行")

    phase = phases[1]
    phase["state"] = "running"
    jobs = [("读图检验员", "读取项目结构"), ("编辑提交员", "检查可交付修改"), ("规范朗读员", "检查命名和文档")]
    with ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(lambda item: worker(item[0], phase["name"], item[1], log), jobs))
    phase["state"] = "done" if all(item["ok"] for item in results) else "failed"

    phase = phases[2]
    phase["state"] = "running"
    event(log, phase["name"], "收集协调者", "running", "收齐三个 worker 的结果")
    time.sleep(0.15)
    accepted = all(item["ok"] for item in results)
    phase["state"] = "done" if accepted else "failed"
    event(log, phase["name"], "收集协调者", phase["state"], "验收通过" if accepted else "存在失败结果")

    phase = phases[3]
    phase["state"] = "running"
    event(log, phase["name"], "哨兵·日志巡查员", "running", "检查事件顺序和遗漏")
    time.sleep(0.15)
    phase["state"] = "done"
    event(log, phase["name"], "哨兵·日志巡查员", "done", f"检查 {len(log)} 条事件")

    return {"status": "done" if accepted else "failed", "phases": phases, "events": log}


if __name__ == "__main__":
    result = run()
    Path("run.json").write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps(result, ensure_ascii=False, indent=2))
