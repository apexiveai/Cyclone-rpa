
from datetime import datetime, timezone
from pathlib import Path
from threading import Lock
from typing import Any
from uuid import uuid4
import json

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field


ROOT = Path(__file__).resolve().parents[2]
WORKFLOW_DIR = ROOT / "workflows"
LOG_DIR = ROOT / "logs"

WORKFLOW_DIR.mkdir(parents=True, exist_ok=True)
LOG_DIR.mkdir(parents=True, exist_ok=True)

app = FastAPI(
    title="ApexiveAI Cyclone RPA",
    version="0.1.0",
    description="Workflow development and robot execution API",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["Content-Type", "Authorization"],
)

lock = Lock()
runs: dict[str, dict[str, Any]] = {}

ALLOWED_ACTIONS = {
    "log",
    "set_variable",
    "condition",
    "http_request",
}


class WorkflowStep(BaseModel):
    id: str
    type: str
    name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)


class WorkflowRequest(BaseModel):
    name: str = "Untitled Workflow"
    steps: list[WorkflowStep] = Field(default_factory=list)


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def log_event(run_id: str, event: dict[str, Any]) -> None:
    path = LOG_DIR / f"{run_id}.jsonl"
    with path.open("a", encoding="utf-8") as file:
        file.write(json.dumps(event, ensure_ascii=False) + "\n")


@app.get("/api/v1/health")
def health():
    return {
        "status": "online",
        "service": "ApexiveAI Cyclone RPA",
        "version": "0.1.0",
        "execution_engine": "local-workflow-engine",
        "timestamp": now(),
    }


@app.get("/api/v1/workflows")
def list_workflows():
    items = []

    for path in WORKFLOW_DIR.glob("*.json"):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            items.append({
                "id": path.stem,
                "name": data.get("name", path.stem),
                "steps": len(data.get("steps", [])),
            })
        except (OSError, json.JSONDecodeError):
            continue

    return {"items": items}


@app.post("/api/v1/workflows")
def save_workflow(workflow: WorkflowRequest):
    if len(workflow.steps) > 500:
        raise HTTPException(400, "Maximum 500 steps per workflow")

    ids = [step.id for step in workflow.steps]
    if len(ids) != len(set(ids)):
        raise HTTPException(400, "Step IDs must be unique")

    for step in workflow.steps:
        if step.type not in ALLOWED_ACTIONS:
            raise HTTPException(
                400,
                f"Unsupported step type: {step.type}",
            )

    workflow_id = str(uuid4())
    destination = WORKFLOW_DIR / f"{workflow_id}.json"
    temporary = destination.with_suffix(".tmp")

    temporary.write_text(
        workflow.model_dump_json(indent=2),
        encoding="utf-8",
    )
    temporary.replace(destination)

    return {
        "id": workflow_id,
        "name": workflow.name,
        "steps": len(workflow.steps),
        "saved": True,
    }


@app.post("/api/v1/workflows/validate")
def validate_workflow(workflow: WorkflowRequest):
    errors = []
    seen = set()

    for index, step in enumerate(workflow.steps):
        if step.id in seen:
            errors.append(f"Step {index + 1}: duplicate ID")
        seen.add(step.id)

        if step.type not in ALLOWED_ACTIONS:
            errors.append(
                f"Step {index + 1}: unsupported type '{step.type}'"
            )

        if step.type == "log" and "message" not in step.config:
            errors.append(
                f"Step {index + 1}: log requires a message"
            )

        if step.type == "set_variable":
            if not step.config.get("name"):
                errors.append(
                    f"Step {index + 1}: variable name is required"
                )

    return {
        "valid": not errors,
        "errors": errors,
        "step_count": len(workflow.steps),
    }


def execute_step(
    step: WorkflowStep,
    variables: dict[str, Any],
    events: list[dict[str, Any]],
) -> dict[str, Any]:
    config = step.config

    if step.type == "log":
        message = str(config.get("message", ""))
        event = {
            "level": "INFO",
            "message": message,
            "timestamp": now(),
        }
        events.append(event)
        return {"logged": message}

    if step.type == "set_variable":
        name = str(config.get("name", "")).strip()

        if not name or len(name) > 100:
            raise ValueError("Invalid variable name")

        value = config.get("value")
        variables[name] = value

        return {"variable": name, "value": value}

    if step.type == "condition":
        name = str(config.get("variable", ""))
        operator = str(config.get("operator", "equals"))
        expected = config.get("value")
        actual = variables.get(name)

        if operator == "equals":
            result = actual == expected
        elif operator == "not_equals":
            result = actual != expected
        elif operator == "exists":
            result = name in variables
        else:
            raise ValueError("Unsupported condition operator")

        return {"condition": result}

    if step.type == "http_request":
        # Network actions are deliberately disabled in this
        # initial engine. Add a controlled connector service later.
        raise ValueError(
            "HTTP connector is not enabled in this build"
        )

    raise ValueError("Unsupported action")


@app.post("/api/v1/runs")
def run_workflow(workflow: WorkflowRequest):
    validation = validate_workflow(workflow)

    if not validation["valid"]:
        raise HTTPException(
            status_code=422,
            detail=validation["errors"],
        )

    run_id = str(uuid4())
    variables: dict[str, Any] = {}
    events: list[dict[str, Any]] = []

    record = {
        "id": run_id,
        "workflow": workflow.name,
        "status": "running",
        "started_at": now(),
        "finished_at": None,
        "steps_completed": 0,
        "total_steps": len(workflow.steps),
        "variables": {},
        "events": events,
        "error": None,
    }

    with lock:
        runs[run_id] = record

    log_event(run_id, {
        "level": "INFO",
        "message": "Workflow execution started",
        "timestamp": now(),
    })

    try:
        for step in workflow.steps:
            result = execute_step(step, variables, events)

            record["steps_completed"] += 1
            events.append({
                "level": "SUCCESS",
                "step_id": step.id,
                "step_name": step.name,
                "result": result,
                "timestamp": now(),
            })

        record["status"] = "completed"

    except Exception as exc:
        record["status"] = "failed"
        record["error"] = str(exc)
        events.append({
            "level": "ERROR",
            "message": str(exc),
            "timestamp": now(),
        })

    record["variables"] = variables
    record["finished_at"] = now()

    for event in events:
        log_event(run_id, event)

    log_event(run_id, {
        "level": "INFO",
        "message": f"Execution ended: {record['status']}",
        "timestamp": now(),
    })

    return record


@app.get("/api/v1/runs")
def list_runs():
    with lock:
        items = list(runs.values())

    return {
        "items": [
            {
                "id": item["id"],
                "workflow": item["workflow"],
                "status": item["status"],
                "started_at": item["started_at"],
                "steps_completed": item["steps_completed"],
                "total_steps": item["total_steps"],
            }
            for item in reversed(items)
        ]
    }


@app.get("/api/v1/runs/{run_id}")
def get_run(run_id: str):
    with lock:
        record = runs.get(run_id)

    if record is None:
        raise HTTPException(
            404,
            "Run not found. Persistent run storage is not enabled yet.",
        )

    return record
