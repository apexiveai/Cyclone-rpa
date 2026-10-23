from __future__ import annotations

import json
import os
import re
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any
from uuid import uuid4

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field
from playwright.sync_api import (
    Browser,
    BrowserContext,
    Page,
    Playwright,
    TimeoutError as PlaywrightTimeoutError,
    sync_playwright,
)


# ============================================================
# APEXIVEAI CYCLONE RPA
# Production Local Runtime
# ============================================================

APP_VERSION = "1.1.0"

ROOT = Path(__file__).resolve().parents[2]

WORKFLOW_DIR = ROOT / "workflows"
EXECUTION_DIR = ROOT / "executions"
LOG_DIR = ROOT / "logs"
SCREENSHOT_DIR = ROOT / "logs" / "screenshots"
BACKUP_DIR = ROOT / "backups"

for directory in (
    WORKFLOW_DIR,
    EXECUTION_DIR,
    LOG_DIR,
    SCREENSHOT_DIR,
    BACKUP_DIR,
):
    directory.mkdir(parents=True, exist_ok=True)


# ============================================================
# APPLICATION
# ============================================================

app = FastAPI(
    title="ApexiveAI Cyclone RPA",
    version=APP_VERSION,
    description=(
        "ApexiveAI Cyclone RPA workflow development, "
        "Playwright browser automation and local execution runtime."
    ),
)


# ============================================================
# CORS
# ============================================================

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
    ],
    allow_credentials=False,
    allow_methods=[
        "GET",
        "POST",
        "PUT",
        "DELETE",
        "OPTIONS",
    ],
    allow_headers=[
        "Content-Type",
        "Authorization",
    ],
)


# ============================================================
# RUNTIME CONFIGURATION
# ============================================================

BROWSER_HEADLESS = (
    os.getenv("CYCLONE_BROWSER_HEADLESS", "false").lower()
    in {"1", "true", "yes", "on"}
)

BROWSER_TIMEOUT_MS = int(
    os.getenv("CYCLONE_BROWSER_TIMEOUT_MS", "30000")
)

NAVIGATION_TIMEOUT_MS = int(
    os.getenv("CYCLONE_NAVIGATION_TIMEOUT_MS", "45000")
)

MAX_WORKFLOW_STEPS = int(
    os.getenv("CYCLONE_MAX_WORKFLOW_STEPS", "500")
)

MAX_EXECUTION_LOGS = int(
    os.getenv("CYCLONE_MAX_EXECUTION_LOGS", "5000")
)


# ============================================================
# LOCKS
# ============================================================

workflow_lock = threading.RLock()
execution_lock = threading.RLock()


# ============================================================
# IN-MEMORY RUNTIME CACHE
# Persistent JSON remains source of truth.
# ============================================================

runs: dict[str, dict[str, Any]] = {}


# ============================================================
# SUPPORTED ACTIONS
# ============================================================

ALLOWED_ACTIONS = {
    "trigger",
    "log",
    "set_variable",
    "condition",
    "http_request",
    "browser",
    "desktop",
    "excel",
    "email",
    "database",
}


# ============================================================
# MODELS
# ============================================================


class WorkflowStep(BaseModel):
    id: str
    type: str
    name: str = ""
    config: dict[str, Any] = Field(default_factory=dict)


class WorkflowRequest(BaseModel):
    name: str = "Untitled Workflow"
    description: str = ""
    definition: dict[str, Any] = Field(
        default_factory=lambda: {
            "nodes": [],
            "edges": [],
        }
    )


class RunRequest(BaseModel):
    trigger_type: str = "manual"
    input_data: dict[str, Any] = Field(default_factory=dict)


# ============================================================
# TIME / IDS
# ============================================================


def now() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id() -> str:
    return uuid4().hex


# ============================================================
# JSON HELPERS
# ============================================================


def read_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json_atomic(path: Path, data: Any) -> None:
    temporary = path.with_suffix(
        path.suffix + f".{uuid4().hex}.tmp"
    )

    temporary.write_text(
        json.dumps(
            data,
            ensure_ascii=False,
            indent=2,
        ),
        encoding="utf-8",
    )

    temporary.replace(path)


def workflow_path(workflow_id: str) -> Path:
    return WORKFLOW_DIR / f"{workflow_id}.json"


def execution_path(execution_id: str) -> Path:
    return EXECUTION_DIR / f"{execution_id}.json"


def execution_log_path(execution_id: str) -> Path:
    return LOG_DIR / f"{execution_id}.jsonl"


# ============================================================
# DEFINITION HELPERS
# ============================================================


def normalize_definition(
    definition: dict[str, Any] | None,
) -> dict[str, Any]:

    if not isinstance(definition, dict):
        return {
            "nodes": [],
            "edges": [],
        }

    nodes = definition.get("nodes", [])
    edges = definition.get("edges", [])

    if not isinstance(nodes, list):
        nodes = []

    if not isinstance(edges, list):
        edges = []

    return {
        "nodes": nodes,
        "edges": edges,
    }


def definition_steps(
    definition: dict[str, Any],
) -> list[dict[str, Any]]:

    definition = normalize_definition(definition)

    nodes = definition["nodes"]

    result: list[dict[str, Any]] = []

    for node in nodes:
        if not isinstance(node, dict):
            continue

        node_id = str(node.get("id", "")).strip()

        data = node.get("data", {})

        if not isinstance(data, dict):
            data = {}

        action_type = str(
            data.get(
                "type",
                node.get("type", ""),
            )
        ).strip()

        label = str(
            data.get(
                "label",
                action_type or "Untitled Step",
            )
        ).strip()

        config = data.get("config", {})

        if not isinstance(config, dict):
            config = {}

        result.append(
            {
                "id": node_id,
                "type": action_type,
                "name": label,
                "config": config,
            }
        )

    return result


# ============================================================
# WORKFLOW VALIDATION
# ============================================================


def validate_definition(
    definition: dict[str, Any],
) -> dict[str, Any]:

    errors: list[str] = []
    warnings: list[str] = []

    definition = normalize_definition(definition)

    nodes = definition["nodes"]
    edges = definition["edges"]

    if len(nodes) > MAX_WORKFLOW_STEPS:
        errors.append(
            f"Maximum {MAX_WORKFLOW_STEPS} steps per workflow"
        )

    seen_ids: set[str] = set()

    for index, node in enumerate(nodes):

        position = index + 1

        if not isinstance(node, dict):
            errors.append(
                f"Step {position}: node must be an object"
            )
            continue

        node_id = str(
            node.get("id", "")
        ).strip()

        if not node_id:
            errors.append(
                f"Step {position}: node ID is required"
            )

        if node_id in seen_ids:
            errors.append(
                f"Step {position}: duplicate ID '{node_id}'"
            )

        seen_ids.add(node_id)

        data = node.get("data", {})

        if not isinstance(data, dict):
            errors.append(
                f"Step {position}: node data must be an object"
            )
            continue

        action_type = str(
            data.get(
                "type",
                node.get("type", ""),
            )
        ).strip()

        if not action_type:
            errors.append(
                f"Step {position}: activity type is required"
            )
            continue

        if action_type not in ALLOWED_ACTIONS:
            errors.append(
                f"Step {position}: unsupported type '{action_type}'"
            )

        config = data.get("config", {})

        if not isinstance(config, dict):
            errors.append(
                f"Step {position}: config must be an object"
            )
            continue

        # ----------------------------------------------------
        # LOG
        # ----------------------------------------------------

        if action_type == "log":
            if "message" not in config:
                errors.append(
                    f"Step {position}: log requires a message"
                )

        # ----------------------------------------------------
        # SET VARIABLE
        # ----------------------------------------------------

        if action_type == "set_variable":
            variable_name = str(
                config.get("name", "")
            ).strip()

            if not variable_name:
                errors.append(
                    f"Step {position}: variable name is required"
                )

            if len(variable_name) > 100:
                errors.append(
                    f"Step {position}: variable name is too long"
                )

        # ----------------------------------------------------
        # CONDITION
        # ----------------------------------------------------

        if action_type == "condition":

            variable_name = str(
                config.get("variable", "")
            ).strip()

            operator = str(
                config.get(
                    "operator",
                    "equals",
                )
            ).strip()

            if not variable_name:
                errors.append(
                    f"Step {position}: condition variable is required"
                )

            allowed_operators = {
                "equals",
                "not_equals",
                "exists",
                "not_exists",
                "contains",
                "not_contains",
                "greater_than",
                "less_than",
            }

            if operator not in allowed_operators:
                errors.append(
                    f"Step {position}: unsupported condition operator '{operator}'"
                )

        # ----------------------------------------------------
        # BROWSER
        # ----------------------------------------------------

        if action_type == "browser":

            browser_action = str(
                config.get(
                    "action",
                    "goto",
                )
            ).strip().lower()

            allowed_browser_actions = {
                "goto",
                "navigate",
                "open",
                "click",
                "fill",
                "type",
                "press",
                "wait",
                "wait_for_selector",
                "extract_text",
                "get_text",
                "screenshot",
                "select_option",
            }

            if browser_action not in allowed_browser_actions:
                errors.append(
                    f"Step {position}: unsupported browser action '{browser_action}'"
                )

            if browser_action in {
                "goto",
                "navigate",
                "open",
            }:

                url = str(
                    config.get(
                        "url",
                        "",
                    )
                ).strip()

                if not url:
                    errors.append(
                        f"Step {position}: browser goto requires 'url'"
                    )

            if browser_action in {
                "click",
                "fill",
                "type",
                "press",
                "wait_for_selector",
                "extract_text",
                "get_text",
                "select_option",
            }:

                selector = str(
                    config.get(
                        "selector",
                        "",
                    )
                ).strip()

                if not selector:
                    errors.append(
                        f"Step {position}: browser action requires 'selector'"
                    )

            if browser_action in {
                "fill",
                "type",
                "press",
            }:

                if "value" not in config and "text" not in config:
                    errors.append(
                        f"Step {position}: browser {browser_action} requires 'value' or 'text'"
                    )

        # ----------------------------------------------------
        # UNSUPPORTED ACTIONS
        # ----------------------------------------------------

        if action_type == "desktop":
            warnings.append(
                f"Step {position}: Desktop Action is reserved for the desktop runtime"
            )

        if action_type == "excel":
            warnings.append(
                f"Step {position}: Excel / CSV runtime adapter is not enabled yet"
            )

        if action_type == "email":
            warnings.append(
                f"Step {position}: Email runtime adapter is not enabled yet"
            )

        if action_type == "database":
            warnings.append(
                f"Step {position}: Database runtime adapter is not enabled yet"
            )

        if action_type == "http_request":
            warnings.append(
                f"Step {position}: HTTP connector is disabled in the local runtime"
            )

    # --------------------------------------------------------
    # EDGE VALIDATION
    # --------------------------------------------------------

    known_ids = seen_ids

    if not isinstance(edges, list):
        errors.append("Edges must be an array")
    else:

        for index, edge in enumerate(edges):

            if not isinstance(edge, dict):
                errors.append(
                    f"Edge {index + 1}: edge must be an object"
                )
                continue

            source = str(
                edge.get("source", "")
            ).strip()

            target = str(
                edge.get("target", "")
            ).strip()

            if source and source not in known_ids:
                errors.append(
                    f"Edge {index + 1}: source '{source}' does not exist"
                )

            if target and target not in known_ids:
                errors.append(
                    f"Edge {index + 1}: target '{target}' does not exist"
                )

    return {
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
        "step_count": len(nodes),
    }


# ============================================================
# WORKFLOW OBJECT
# ============================================================


def build_workflow_record(
    workflow_id: str,
    payload: WorkflowRequest,
    version: int,
    created_at: str | None = None,
) -> dict[str, Any]:

    timestamp = now()

    return {
        "id": workflow_id,
        "name": payload.name.strip() or "Untitled Workflow",
        "description": payload.description.strip(),
        "status": "draft",
        "version": version,
        "definition": normalize_definition(
            payload.definition
        ),
        "created_at": created_at or timestamp,
        "updated_at": timestamp,
    }


# ============================================================
# VERSION STORAGE
# ============================================================


def version_directory(
    workflow_id: str,
) -> Path:

    directory = WORKFLOW_DIR / workflow_id / "versions"

    directory.mkdir(
        parents=True,
        exist_ok=True,
    )

    return directory


def version_path(
    workflow_id: str,
    version: int,
) -> Path:

    return (
        version_directory(workflow_id)
        / f"{version}.json"
    )


def save_version(
    workflow: dict[str, Any],
) -> None:

    workflow_id = str(workflow["id"])
    version = int(workflow["version"])

    data = {
        "id": new_id(),
        "workflow_id": workflow_id,
        "version": version,
        "name": workflow["name"],
        "description": workflow.get(
            "description",
            "",
        ),
        "definition": workflow["definition"],
        "created_at": now(),
    }

    write_json_atomic(
        version_path(
            workflow_id,
            version,
        ),
        data,
    )


def list_versions(
    workflow_id: str,
) -> list[dict[str, Any]]:

    directory = version_directory(workflow_id)

    versions: list[dict[str, Any]] = []

    for path in directory.glob("*.json"):

        try:
            data = read_json(path)
            versions.append(data)
        except (
            OSError,
            json.JSONDecodeError,
        ):
            continue

    versions.sort(
        key=lambda item: int(
            item.get("version", 0)
        ),
        reverse=True,
    )

    return versions


# ============================================================
# EXECUTION LOGGING
# ============================================================


def append_execution_log(
    execution_id: str,
    event: dict[str, Any],
) -> None:

    path = execution_log_path(execution_id)

    with path.open(
        "a",
        encoding="utf-8",
    ) as file:

        file.write(
            json.dumps(
                event,
                ensure_ascii=False,
            )
            + "\n"
        )


def read_execution_logs(
    execution_id: str,
) -> list[dict[str, Any]]:

    path = execution_log_path(execution_id)

    if not path.exists():
        return []

    items: list[dict[str, Any]] = []

    for line in path.read_text(
        encoding="utf-8"
    ).splitlines():

        if not line.strip():
            continue

        try:
            items.append(
                json.loads(line)
            )
        except json.JSONDecodeError:
            continue

    return items[-MAX_EXECUTION_LOGS:]


def execution_event(
    execution_id: str,
    level: str,
    message: str,
    **extra: Any,
) -> dict[str, Any]:

    event = {
        "level": level,
        "message": message,
        "timestamp": now(),
    }

    event.update(extra)

    append_execution_log(
        execution_id,
        event,
    )

    return event


# ============================================================
# PERSISTENT EXECUTION
# ============================================================


def persist_execution(
    record: dict[str, Any],
) -> None:

    write_json_atomic(
        execution_path(
            str(record["id"])
        ),
        record,
    )


def load_execution(
    execution_id: str,
) -> dict[str, Any] | None:

    path = execution_path(execution_id)

    if not path.exists():
        return None

    try:
        return read_json(path)
    except (
        OSError,
        json.JSONDecodeError,
    ):
        return None


# ============================================================
# VARIABLE RESOLUTION
# ============================================================


VARIABLE_PATTERN = re.compile(
    r"\{\{\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*\}\}"
)


def resolve_value(
    value: Any,
    variables: dict[str, Any],
) -> Any:

    if isinstance(value, str):

        def replace(match: re.Match[str]) -> str:

            key = match.group(1)

            current: Any = variables

            for part in key.split("."):

                if isinstance(current, dict):
                    current = current.get(part)
                else:
                    current = None
                    break

            return (
                ""
                if current is None
                else str(current)
            )

        return VARIABLE_PATTERN.sub(
            replace,
            value,
        )

    if isinstance(value, dict):

        return {
            key: resolve_value(
                item,
                variables,
            )
            for key, item in value.items()
        }

    if isinstance(value, list):

        return [
            resolve_value(
                item,
                variables,
            )
            for item in value
        ]

    return value


# ============================================================
# PLAYWRIGHT RUNTIME
# ============================================================


class BrowserRuntime:

    def __init__(
        self,
        execution_id: str,
        variables: dict[str, Any],
    ) -> None:

        self.execution_id = execution_id
        self.variables = variables

        self.playwright: Playwright | None = None
        self.browser: Browser | None = None
        self.context: BrowserContext | None = None
        self.page: Page | None = None

    def start(self) -> None:

        self.playwright = sync_playwright().start()

        self.browser = (
            self.playwright.chromium.launch(
                headless=BROWSER_HEADLESS,
            )
        )

        self.context = (
            self.browser.new_context(
                viewport={
                    "width": 1440,
                    "height": 900,
                },
                ignore_https_errors=True,
            )
        )

        self.page = self.context.new_page()

        self.page.set_default_timeout(
            BROWSER_TIMEOUT_MS
        )

        self.page.set_default_navigation_timeout(
            NAVIGATION_TIMEOUT_MS
        )

    def ensure_page(self) -> Page:

        if self.page is None:
            self.start()

        if self.page is None:
            raise RuntimeError(
                "Browser page could not be created"
            )

        return self.page

    def close(self) -> None:

        try:
            if self.context is not None:
                self.context.close()
        except Exception:
            pass

        try:
            if self.browser is not None:
                self.browser.close()
        except Exception:
            pass

        try:
            if self.playwright is not None:
                self.playwright.stop()
        except Exception:
            pass

        self.page = None
        self.context = None
        self.browser = None
        self.playwright = None


# ============================================================
# BROWSER ACTION EXECUTION
# ============================================================


def execute_browser_action(
    step: dict[str, Any],
    variables: dict[str, Any],
    runtime: BrowserRuntime,
) -> dict[str, Any]:

    config = resolve_value(
        step.get("config", {}),
        variables,
    )

    if not isinstance(config, dict):
        raise ValueError(
            "Browser config must be an object"
        )

    action = str(
        config.get(
            "action",
            "goto",
        )
    ).strip().lower()

    page = runtime.ensure_page()

    # --------------------------------------------------------
    # GOTO
    # --------------------------------------------------------

    if action in {
        "goto",
        "navigate",
        "open",
    }:

        url = str(
            config.get(
                "url",
                "",
            )
        ).strip()

        if not url:
            raise ValueError(
                "Browser goto requires a URL"
            )

        if not (
            url.startswith("http://")
            or url.startswith("https://")
        ):
            raise ValueError(
                "Browser URL must start with http:// or https://"
            )

        wait_until = str(
            config.get(
                "wait_until",
                "domcontentloaded",
            )
        )

        allowed_wait_until = {
            "commit",
            "domcontentloaded",
            "load",
            "networkidle",
        }

        if wait_until not in allowed_wait_until:
            wait_until = "domcontentloaded"

        response = page.goto(
            url,
            wait_until=wait_until,
            timeout=int(
                config.get(
                    "timeout",
                    NAVIGATION_TIMEOUT_MS,
                )
            ),
        )

        current_url = page.url

        return {
            "action": "goto",
            "url": current_url,
            "status": (
                response.status
                if response is not None
                else None
            ),
            "title": page.title(),
        }

    # --------------------------------------------------------
    # CLICK
    # --------------------------------------------------------

    if action == "click":

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        if not selector:
            raise ValueError(
                "Browser click requires selector"
            )

        page.locator(
            selector
        ).first.click(
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            )
        )

        return {
            "action": "click",
            "selector": selector,
            "url": page.url,
            "title": page.title(),
        }

    # --------------------------------------------------------
    # FILL
    # --------------------------------------------------------

    if action == "fill":

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        value = config.get(
            "value",
            config.get(
                "text",
                "",
            ),
        )

        if not selector:
            raise ValueError(
                "Browser fill requires selector"
            )

        page.locator(
            selector
        ).first.fill(
            str(value),
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            ),
        )

        return {
            "action": "fill",
            "selector": selector,
            "value_length": len(str(value)),
        }

    # --------------------------------------------------------
    # TYPE
    # --------------------------------------------------------

    if action == "type":

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        value = config.get(
            "value",
            config.get(
                "text",
                "",
            ),
        )

        if not selector:
            raise ValueError(
                "Browser type requires selector"
            )

        page.locator(
            selector
        ).first.press_sequentially(
            str(value),
            delay=int(
                config.get(
                    "delay",
                    30,
                )
            ),
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            ),
        )

        return {
            "action": "type",
            "selector": selector,
            "value_length": len(str(value)),
        }

    # --------------------------------------------------------
    # PRESS
    # --------------------------------------------------------

    if action == "press":

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        value = str(
            config.get(
                "value",
                config.get(
                    "text",
                    "Enter",
                ),
            )
        )

        if not selector:
            raise ValueError(
                "Browser press requires selector"
            )

        page.locator(
            selector
        ).first.press(
            value,
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            ),
        )

        return {
            "action": "press",
            "selector": selector,
            "key": value,
        }

    # --------------------------------------------------------
    # WAIT
    # --------------------------------------------------------

    if action == "wait":

        milliseconds = int(
            config.get(
                "milliseconds",
                config.get(
                    "ms",
                    1000,
                ),
            )
        )

        if milliseconds < 0:
            raise ValueError(
                "Wait milliseconds cannot be negative"
            )

        if milliseconds > 300000:
            raise ValueError(
                "Maximum wait is 300000 milliseconds"
            )

        page.wait_for_timeout(
            milliseconds
        )

        return {
            "action": "wait",
            "milliseconds": milliseconds,
        }

    # --------------------------------------------------------
    # WAIT FOR SELECTOR
    # --------------------------------------------------------

    if action == "wait_for_selector":

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        state = str(
            config.get(
                "state",
                "visible",
            )
        )

        if state not in {
            "attached",
            "detached",
            "hidden",
            "visible",
        }:
            state = "visible"

        if not selector:
            raise ValueError(
                "wait_for_selector requires selector"
            )

        page.wait_for_selector(
            selector,
            state=state,
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            ),
        )

        return {
            "action": "wait_for_selector",
            "selector": selector,
            "state": state,
        }

    # --------------------------------------------------------
    # EXTRACT TEXT
    # --------------------------------------------------------

    if action in {
        "extract_text",
        "get_text",
    }:

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        variable_name = str(
            config.get(
                "variable",
                config.get(
                    "save_as",
                    "",
                ),
            )
        ).strip()

        if not selector:
            raise ValueError(
                "extract_text requires selector"
            )

        text = page.locator(
            selector
        ).first.inner_text(
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            )
        )

        if variable_name:
            variables[variable_name] = text

        return {
            "action": "extract_text",
            "selector": selector,
            "text": text,
            "saved_to": variable_name or None,
        }

    # --------------------------------------------------------
    # SCREENSHOT
    # --------------------------------------------------------

    if action == "screenshot":

        filename = str(
            config.get(
                "filename",
                f"{runtime.execution_id}_{step['id']}.png",
            )
        ).strip()

        filename = Path(filename).name

        if not filename.lower().endswith(
            (".png", ".jpg", ".jpeg")
        ):
            filename += ".png"

        destination = (
            SCREENSHOT_DIR / filename
        )

        page.screenshot(
            path=str(destination),
            full_page=bool(
                config.get(
                    "full_page",
                    True,
                )
            ),
        )

        return {
            "action": "screenshot",
            "path": str(destination),
        }

    # --------------------------------------------------------
    # SELECT OPTION
    # --------------------------------------------------------

    if action == "select_option":

        selector = str(
            config.get(
                "selector",
                "",
            )
        ).strip()

        value = config.get("value")

        if not selector:
            raise ValueError(
                "select_option requires selector"
            )

        if value is None:
            raise ValueError(
                "select_option requires value"
            )

        selected = page.locator(
            selector
        ).first.select_option(
            str(value),
            timeout=int(
                config.get(
                    "timeout",
                    BROWSER_TIMEOUT_MS,
                )
            ),
        )

        return {
            "action": "select_option",
            "selector": selector,
            "selected": selected,
        }

    raise ValueError(
        f"Unsupported browser action: {action}"
    )


# ============================================================
# STEP EXECUTION
# ============================================================


def execute_step(
    step: dict[str, Any],
    variables: dict[str, Any],
    events: list[dict[str, Any]],
    runtime: BrowserRuntime,
) -> dict[str, Any]:

    step_type = str(
        step.get(
            "type",
            "",
        )
    ).strip()

    config = step.get(
        "config",
        {},
    )

    if not isinstance(config, dict):
        config = {}

    # --------------------------------------------------------
    # TRIGGER
    # --------------------------------------------------------

    if step_type == "trigger":

        return {
            "trigger": "manual",
        }

    # --------------------------------------------------------
    # LOG
    # --------------------------------------------------------

    if step_type == "log":

        message = resolve_value(
            config.get(
                "message",
                "",
            ),
            variables,
        )

        event = {
            "level": "INFO",
            "message": str(message),
            "timestamp": now(),
        }

        events.append(event)

        return {
            "logged": str(message),
        }

    # --------------------------------------------------------
    # SET VARIABLE
    # --------------------------------------------------------

    if step_type == "set_variable":

        name = str(
            config.get(
                "name",
                "",
            )
        ).strip()

        if not name:
            raise ValueError(
                "Invalid variable name"
            )

        if len(name) > 100:
            raise ValueError(
                "Variable name is too long"
            )

        value = resolve_value(
            config.get(
                "value"
            ),
            variables,
        )

        variables[name] = value

        return {
            "variable": name,
            "value": value,
        }

    # --------------------------------------------------------
    # CONDITION
    # --------------------------------------------------------

    if step_type == "condition":

        name = str(
            config.get(
                "variable",
                "",
            )
        ).strip()

        operator = str(
            config.get(
                "operator",
                "equals",
            )
        ).strip()

        expected = resolve_value(
            config.get(
                "value"
            ),
            variables,
        )

        actual = variables.get(name)

        if operator == "equals":
            result = actual == expected

        elif operator == "not_equals":
            result = actual != expected

        elif operator == "exists":
            result = name in variables

        elif operator == "not_exists":
            result = name not in variables

        elif operator == "contains":

            result = (
                str(expected) in str(actual)
                if actual is not None
                else False
            )

        elif operator == "not_contains":

            result = (
                str(expected) not in str(actual)
                if actual is not None
                else True
            )

        elif operator == "greater_than":

            result = (
                actual > expected
                if actual is not None
                else False
            )

        elif operator == "less_than":

            result = (
                actual < expected
                if actual is not None
                else False
            )

        else:
            raise ValueError(
                f"Unsupported condition operator: {operator}"
            )

        return {
            "condition": result,
            "variable": name,
            "actual": actual,
            "expected": expected,
            "operator": operator,
        }

    # --------------------------------------------------------
    # BROWSER
    # --------------------------------------------------------

    if step_type == "browser":

        return execute_browser_action(
            step,
            variables,
            runtime,
        )

    # --------------------------------------------------------
    # HTTP
    # --------------------------------------------------------

    if step_type == "http_request":

        raise ValueError(
            "HTTP connector is not enabled in this build. "
            "Use a controlled connector service before enabling network actions."
        )

    # --------------------------------------------------------
    # DESKTOP
    # --------------------------------------------------------

    if step_type == "desktop":

        raise ValueError(
            "Desktop Action runtime is not enabled yet."
        )

    # --------------------------------------------------------
    # EXCEL
    # --------------------------------------------------------

    if step_type == "excel":

        raise ValueError(
            "Excel / CSV runtime adapter is not enabled yet."
        )

    # --------------------------------------------------------
    # EMAIL
    # --------------------------------------------------------

    if step_type == "email":

        raise ValueError(
            "Email runtime adapter is not enabled yet."
        )

    # --------------------------------------------------------
    # DATABASE
    # --------------------------------------------------------

    if step_type == "database":

        raise ValueError(
            "Database runtime adapter is not enabled yet."
        )

    raise ValueError(
        f"Unsupported action: {step_type}"
    )


# ============================================================
# EXECUTION ENGINE
# ============================================================


def execute_workflow(
    workflow: dict[str, Any],
    run_request: RunRequest,
) -> dict[str, Any]:

    execution_id = new_id()

    definition = normalize_definition(
        workflow.get("definition")
    )

    steps = definition_steps(
        definition
    )

    validation = validate_definition(
        definition
    )

    if not validation["valid"]:
        raise HTTPException(
            status_code=422,
            detail=validation["errors"],
        )

    variables: dict[str, Any] = dict(
        run_request.input_data
    )

    events: list[dict[str, Any]] = []

    started_at = now()

    record: dict[str, Any] = {
        "id": execution_id,
        "workflow_id": workflow["id"],
        "workflow": workflow["name"],
        "workflow_version": workflow["version"],
        "status": "running",
        "trigger_type": run_request.trigger_type,
        "input_data": run_request.input_data,
        "created_at": started_at,
        "started_at": started_at,
        "finished_at": None,
        "steps_completed": 0,
        "total_steps": len(steps),
        "error_message": None,
        "error": None,
        "variables": {},
    }

    with execution_lock:
        runs[execution_id] = record

    persist_execution(record)

    execution_event(
        execution_id,
        "INFO",
        "Workflow execution started",
    )

    runtime = BrowserRuntime(
        execution_id=execution_id,
        variables=variables,
    )

    try:

        for step in steps:

            step_id = str(
                step.get(
                    "id",
                    "",
                )
            )

            step_name = str(
                step.get(
                    "name",
                    step_id,
                )
            )

            step_type = str(
                step.get(
                    "type",
                    "",
                )
            )

            execution_event(
                execution_id,
                "INFO",
                f"Starting: {step_name}",
                step_id=step_id,
                step_type=step_type,
            )

            try:

                result = execute_step(
                    step,
                    variables,
                    events,
                    runtime,
                )

                record["steps_completed"] += 1

                execution_event(
                    execution_id,
                    "SUCCESS",
                    f"Completed: {step_name}",
                    step_id=step_id,
                    step_name=step_name,
                    result=result,
                )

            except PlaywrightTimeoutError as exc:

                message = (
                    f"Playwright timeout in step '{step_name}': "
                    f"{str(exc)}"
                )

                execution_event(
                    execution_id,
                    "ERROR",
                    message,
                    step_id=step_id,
                    step_name=step_name,
                )

                raise RuntimeError(message) from exc

        record["status"] = "completed"

        execution_event(
            execution_id,
            "INFO",
            "Execution ended: completed",
        )

    except Exception as exc:

        message = str(exc)

        record["status"] = "failed"
        record["error_message"] = message
        record["error"] = message

        execution_event(
            execution_id,
            "ERROR",
            message,
        )

        execution_event(
            execution_id,
            "INFO",
            "Execution ended: failed",
        )

    finally:

        record["variables"] = variables
        record["finished_at"] = now()

        runtime.close()

        with execution_lock:
            runs[execution_id] = record

        persist_execution(record)

    return record


# ============================================================
# HEALTH
# ============================================================


@app.get("/api/v1/health")
def health() -> dict[str, Any]:

    browser_runtime = "available"

    try:
        import playwright  # noqa: F401
    except Exception:
        browser_runtime = "unavailable"

    return {
        "status": "online",
        "service": "ApexiveAI Cyclone RPA",
        "version": APP_VERSION,
        "execution_engine": "playwright-local",
        "workflow_storage": "persistent-json",
        "execution_history": "persistent-json",
        "browser_runtime": browser_runtime,
        "browser_headless": BROWSER_HEADLESS,
        "timestamp": now(),
    }


# ============================================================
# WORKFLOWS - LIST
# ============================================================


@app.get("/api/v1/workflows")
def list_workflows() -> dict[str, Any]:

    items: list[dict[str, Any]] = []

    with workflow_lock:

        for path in WORKFLOW_DIR.glob("*.json"):

            try:

                data = read_json(path)

                items.append(data)

            except (
                OSError,
                json.JSONDecodeError,
            ):
                continue

    items.sort(
        key=lambda item: item.get(
            "updated_at",
            "",
        ),
        reverse=True,
    )

    return {
        "items": items,
        "total": len(items),
    }


# ============================================================
# WORKFLOW - CREATE
# ============================================================


@app.post("/api/v1/workflows")
def create_workflow(
    payload: WorkflowRequest,
) -> dict[str, Any]:

    validation = validate_definition(
        payload.definition
    )

    if not validation["valid"]:
        raise HTTPException(
            status_code=422,
            detail=validation["errors"],
        )

    workflow_id = new_id()

    workflow = build_workflow_record(
        workflow_id=workflow_id,
        payload=payload,
        version=1,
    )

    with workflow_lock:

        write_json_atomic(
            workflow_path(workflow_id),
            workflow,
        )

        save_version(workflow)

    return workflow


# ============================================================
# WORKFLOW - GET
# ============================================================


@app.get("/api/v1/workflows/{workflow_id}")
def get_workflow(
    workflow_id: str,
) -> dict[str, Any]:

    path = workflow_path(workflow_id)

    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Workflow not found",
        )

    try:
        return read_json(path)
    except (
        OSError,
        json.JSONDecodeError,
    ) as exc:

        raise HTTPException(
            status_code=500,
            detail=f"Workflow storage error: {exc}",
        ) from exc


# ============================================================
# WORKFLOW - UPDATE
# ============================================================


@app.put("/api/v1/workflows/{workflow_id}")
def update_workflow(
    workflow_id: str,
    payload: WorkflowRequest,
) -> dict[str, Any]:

    path = workflow_path(workflow_id)

    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Workflow not found",
        )

    validation = validate_definition(
        payload.definition
    )

    if not validation["valid"]:
        raise HTTPException(
            status_code=422,
            detail=validation["errors"],
        )

    with workflow_lock:

        try:
            current = read_json(path)
        except (
            OSError,
            json.JSONDecodeError,
        ) as exc:

            raise HTTPException(
                status_code=500,
                detail=f"Workflow storage error: {exc}",
            ) from exc

        current_version = int(
            current.get(
                "version",
                1,
            )
        )

        workflow = build_workflow_record(
            workflow_id=workflow_id,
            payload=payload,
            version=current_version + 1,
            created_at=current.get(
                "created_at"
            ),
        )

        write_json_atomic(
            path,
            workflow,
        )

        save_version(workflow)

    return workflow


# ============================================================
# WORKFLOW - DELETE
# ============================================================


@app.delete("/api/v1/workflows/{workflow_id}")
def delete_workflow(
    workflow_id: str,
) -> dict[str, Any]:

    path = workflow_path(workflow_id)

    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Workflow not found",
        )

    with workflow_lock:

        try:
            path.unlink()
        except OSError as exc:

            raise HTTPException(
                status_code=500,
                detail=f"Could not delete workflow: {exc}",
            ) from exc

    return {
        "id": workflow_id,
        "deleted": True,
    }


# ============================================================
# WORKFLOW - VALIDATE
# ============================================================


@app.post("/api/v1/workflows/{workflow_id}/validate")
def validate_saved_workflow(
    workflow_id: str,
) -> dict[str, Any]:

    path = workflow_path(workflow_id)

    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Workflow not found",
        )

    try:
        workflow = read_json(path)
    except (
        OSError,
        json.JSONDecodeError,
    ) as exc:

        raise HTTPException(
            status_code=500,
            detail=f"Workflow storage error: {exc}",
        ) from exc

    return validate_definition(
        workflow.get(
            "definition"
        )
    )


# ============================================================
# WORKFLOW - VERSIONS
# ============================================================


@app.get("/api/v1/workflows/{workflow_id}/versions")
def get_workflow_versions(
    workflow_id: str,
) -> dict[str, Any]:

    path = workflow_path(workflow_id)

    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Workflow not found",
        )

    return {
        "items": list_versions(
            workflow_id
        )
    }


# ============================================================
# WORKFLOW - RUN
# ============================================================


@app.post("/api/v1/workflows/{workflow_id}/run")
def run_saved_workflow(
    workflow_id: str,
    request: RunRequest,
) -> dict[str, Any]:

    path = workflow_path(workflow_id)

    if not path.exists():
        raise HTTPException(
            status_code=404,
            detail="Workflow not found",
        )

    try:
        workflow = read_json(path)
    except (
        OSError,
        json.JSONDecodeError,
    ) as exc:

        raise HTTPException(
            status_code=500,
            detail=f"Workflow storage error: {exc}",
        ) from exc

    return execute_workflow(
        workflow,
        request,
    )


# ============================================================
# EXECUTIONS - LIST
# ============================================================


@app.get("/api/v1/executions")
def list_executions() -> dict[str, Any]:

    items: list[dict[str, Any]] = []

    with execution_lock:

        for path in EXECUTION_DIR.glob("*.json"):

            try:

                data = read_json(path)

                items.append(
                    {
                        "id": data.get("id"),
                        "workflow_id": data.get(
                            "workflow_id"
                        ),
                        "workflow": data.get(
                            "workflow"
                        ),
                        "workflow_version": data.get(
                            "workflow_version"
                        ),
                        "status": data.get(
                            "status"
                        ),
                        "trigger_type": data.get(
                            "trigger_type"
                        ),
                        "created_at": data.get(
                            "created_at"
                        ),
                        "started_at": data.get(
                            "started_at"
                        ),
                        "finished_at": data.get(
                            "finished_at"
                        ),
                        "steps_completed": data.get(
                            "steps_completed",
                            0,
                        ),
                        "total_steps": data.get(
                            "total_steps",
                            0,
                        ),
                        "error_message": data.get(
                            "error_message"
                        ),
                        "error": data.get(
                            "error"
                        ),
                        "variables": data.get(
                            "variables",
                            {},
                        ),
                    }
                )

            except (
                OSError,
                json.JSONDecodeError,
            ):
                continue

    items.sort(
        key=lambda item: item.get(
            "created_at",
            "",
        ),
        reverse=True,
    )

    return {
        "items": items,
    }


# ============================================================
# EXECUTION - GET
# ============================================================


@app.get("/api/v1/executions/{execution_id}")
def get_execution(
    execution_id: str,
) -> dict[str, Any]:

    record = load_execution(
        execution_id
    )

    if record is None:
        raise HTTPException(
            status_code=404,
            detail="Execution not found",
        )

    return record


# ============================================================
# EXECUTION - LOGS
# ============================================================


@app.get("/api/v1/executions/{execution_id}/logs")
def get_execution_logs(
    execution_id: str,
) -> dict[str, Any]:

    record = load_execution(
        execution_id
    )

    if record is None:
        raise HTTPException(
            status_code=404,
            detail="Execution not found",
        )

    return {
        "items": read_execution_logs(
            execution_id
        )
    }


# ============================================================
# RUNTIME INFO
# ============================================================


@app.get("/api/v1/runtime")
def runtime_info() -> dict[str, Any]:

    return {
        "engine": "playwright-local",
        "browser": "chromium",
        "headless": BROWSER_HEADLESS,
        "browser_timeout_ms": BROWSER_TIMEOUT_MS,
        "navigation_timeout_ms": NAVIGATION_TIMEOUT_MS,
        "max_workflow_steps": MAX_WORKFLOW_STEPS,
        "supported_actions": sorted(
            ALLOWED_ACTIONS
        ),
        "browser_actions": [
            "goto",
            "navigate",
            "open",
            "click",
            "fill",
            "type",
            "press",
            "wait",
            "wait_for_selector",
            "extract_text",
            "get_text",
            "screenshot",
            "select_option",
        ],
    }


# ============================================================
# ROOT
# ============================================================


@app.get("/")
def root() -> dict[str, Any]:

    return {
        "service": "ApexiveAI Cyclone RPA",
        "version": APP_VERSION,
        "status": "online",
        "api": "/api/v1",
        "health": "/api/v1/health",
        "runtime": "/api/v1/runtime",
    }


# ============================================================
# LOCAL DEVELOPMENT ENTRYPOINT
# ============================================================


if __name__ == "__main__":

    import uvicorn

    uvicorn.run(
        "app.main:app",
        host="127.0.0.1",
        port=8026,
        reload=False,
    )