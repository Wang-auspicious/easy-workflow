"""Declarative software-engineering workflow for the workflow runtime."""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class ActorSpec:
    id: str
    name: str
    role: str
    task: str
    phase_id: str


@dataclass(frozen=True)
class PhaseSpec:
    id: str
    name: str
    discipline: str
    actors: tuple[ActorSpec, ...]
    fanout: bool = False


WORKFLOW_ID = "software-engineering-review"
WORKFLOW_TITLE = "软件工程审查工作流"

PHASES = (
    PhaseSpec(
        "requirements",
        "需求与范围",
        "Software Requirements",
        (ActorSpec("requirements-coordinator", "需求协调者", "coordinator", "确认目标、输入和验收标准", "requirements"),),
    ),
    PhaseSpec(
        "design",
        "设计与依赖审查",
        "Software Design",
        (
            ActorSpec("architecture-reviewer", "架构审查员", "reviewer", "检查模块边界和依赖关系", "design"),
            ActorSpec("evidence-reviewer", "证据审查员", "reviewer", "检查证据链和可追溯性", "design"),
            ActorSpec("test-planner", "测试规划员", "tester", "提出可执行的验收条件", "design"),
        ),
        fanout=True,
    ),
    PhaseSpec(
        "construction",
        "实现与变更检查",
        "Software Construction",
        (ActorSpec("implementation-reviewer", "实现检验员", "builder", "检查实现是否满足设计约束", "construction"),),
    ),
    PhaseSpec(
        "testing",
        "测试与质量验证",
        "Software Testing",
        (ActorSpec("test-runner", "测试验证员", "tester", "运行单元与回归检查", "testing"),),
    ),
    PhaseSpec(
        "maintenance",
        "维护与交付反馈",
        "Software Maintenance",
        (ActorSpec("maintenance-recorder", "维护记录员", "maintainer", "形成修复建议、风险和后续动作", "maintenance"),),
    ),
)


def all_actors() -> tuple[ActorSpec, ...]:
    return tuple(actor for phase in PHASES for actor in phase.actors)


def actor_map() -> dict[str, ActorSpec]:
    return {actor.id: actor for actor in all_actors()}


def graph_template() -> dict:
    """Return stable topology; runtime state is added by the engine."""
    nodes: list[dict] = []
    edges: list[dict] = []
    for index, phase in enumerate(PHASES):
        phase_node = f"phase:{phase.id}"
        nodes.append({
            "id": phase_node,
            "kind": "phase",
            "label": phase.name,
            "discipline": phase.discipline,
            "order": index,
        })
        for actor in phase.actors:
            actor_node = f"actor:{actor.id}"
            nodes.append({
                "id": actor_node,
                "kind": "actor",
                "label": actor.name,
                "role": actor.role,
                "phase_id": phase.id,
            })
            edges.append({
                "id": f"contains:{phase.id}:{actor.id}",
                "source": phase_node,
                "target": actor_node,
                "kind": "contains",
            })
        if index:
            previous = PHASES[index - 1]
            edges.append({
                "id": f"handoff:{previous.id}:{phase.id}",
                "source": f"phase:{previous.id}",
                "target": phase_node,
                "kind": "handoff",
            })
    return {
        "workflow_id": WORKFLOW_ID,
        "title": WORKFLOW_TITLE,
        "nodes": nodes,
        "edges": edges,
    }
