
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Activity,
  AlertCircle,
  ArrowDown,
  Bot,
  Check,
  ChevronDown,
  CirclePlay,
  Clock,
  Database,
  FileSpreadsheet,
  GitBranch,
  History,
  LoaderCircle,
  Mail,
  Plus,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
  Workflow,
  Zap,
} from "lucide-react";

import "./WorkflowDesigner.css";

const API = "http://127.0.0.1:8025/api/v1";

type WorkflowNode = {
  id: string;
  type: string;
  position: { x: number; y: number };
  data: { label: string; type: string; config: Record<string, unknown> };
};

type WorkflowEdge = {
  id: string;
  source: string;
  target: string;
  type?: string;
};

type Definition = {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
};

type WorkflowRecord = {
  id: number | string;
  name: string;
  description?: string;
  status?: string;
  version?: number;
  definition?: Definition;
  created_at?: string;
  updated_at?: string;
};

type ExecutionRecord = {
  id: number | string;
  workflow_id?: number | string;
  workflow_version?: number;
  status?: string;
  trigger_type?: string;
  error_message?: string;
  created_at?: string;
  started_at?: string;
  finished_at?: string;
};

type VersionRecord = {
  id: number | string;
  version?: number;
  name?: string;
  description?: string;
  created_at?: string;
};

type ApiError = { detail?: string; message?: string };

const palette = [
  { type: "trigger", label: "Manual Trigger", icon: Zap, color: "#a78bfa" },
  { type: "browser", label: "Browser Action", icon: Workflow, color: "#60a5fa" },
  { type: "desktop", label: "Desktop Action", icon: Bot, color: "#38bdf8" },
  { type: "excel", label: "Excel / CSV", icon: FileSpreadsheet, color: "#34d399" },
  { type: "email", label: "Send Email", icon: Mail, color: "#fbbf24" },
  { type: "database", label: "Database", icon: Database, color: "#fb923c" },
  { type: "condition", label: "Condition", icon: GitBranch, color: "#f472b6" },
];

const emptyDefinition = (): Definition => ({ nodes: [], edges: [] });

function normalizeDefinition(value?: Definition): Definition {
  if (!value || !Array.isArray(value.nodes) || !Array.isArray(value.edges)) {
    return emptyDefinition();
  }
  return {
    nodes: value.nodes,
    edges: value.edges,
  };
}

async function apiRequest<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...init?.headers,
    },
    signal: AbortSignal.timeout(12000),
  });

  const text = await response.text();
  let data: unknown = {};

  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { detail: text || `HTTP ${response.status}` };
  }

  if (!response.ok) {
    const error = data as ApiError;
    throw new Error(
      error.detail ?? error.message ?? `Request failed: HTTP ${response.status}`,
    );
  }

  return data as T;
}

function formatDate(value?: string) {
  if (!value) return "—";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

function WorkflowDesigner() {
  const [workflows, setWorkflows] = useState<WorkflowRecord[]>([]);
  const [executions, setExecutions] = useState<ExecutionRecord[]>([]);
  const [versions, setVersions] = useState<VersionRecord[]>([]);
  const [selectedId, setSelectedId] = useState<string>("");
  const [name, setName] = useState("New Automation");
  const [description, setDescription] = useState("");
  const [definition, setDefinition] = useState<Definition>(emptyDefinition);
  const [selectedNodeId, setSelectedNodeId] = useState("");
  const [activePanel, setActivePanel] = useState<
    "nodes" | "executions" | "versions" | "logs"
  >("nodes");
  const [executionLogs, setExecutionLogs] = useState<Record<string, unknown>[]>([]);
  const [selectedExecution, setSelectedExecution] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState("Connecting to workflow API...");
  const [messageType, setMessageType] = useState<"info" | "success" | "error">("info");
  const [apiOnline, setApiOnline] = useState(false);

  const selectedNode = useMemo(
    () => definition.nodes.find((node) => node.id === selectedNodeId),
    [definition.nodes, selectedNodeId],
  );

  const selectedWorkflow = useMemo(
    () => workflows.find((workflow) => String(workflow.id) === selectedId),
    [workflows, selectedId],
  );

  const notify = useCallback(
    (text: string, type: "info" | "success" | "error" = "info") => {
      setMessage(text);
      setMessageType(type);
    },
    [],
  );

  const refreshWorkflows = useCallback(async () => {
    setLoading(true);
    try {
      const data = await apiRequest<{ items?: WorkflowRecord[] } | WorkflowRecord[]>(
        "/workflows",
      );
      const items = Array.isArray(data) ? data : data.items ?? [];
      setWorkflows(items);
      setApiOnline(true);

      if (items.length > 0) {
        const existing = items.find((item) => String(item.id) === selectedId);
        if (!existing) {
          const first = items[0];
          setSelectedId(String(first.id));
          setName(first.name);
          setDescription(first.description ?? "");
          setDefinition(normalizeDefinition(first.definition));
        }
      } else if (!selectedId) {
        setName("New Automation");
        setDescription("");
        setDefinition(emptyDefinition());
      }
    } catch (error) {
      setApiOnline(false);
      notify(`Workflow API unavailable: ${String(error)}`, "error");
    } finally {
      setLoading(false);
    }
  }, [notify, selectedId]);

  const refreshExecutions = useCallback(async () => {
    try {
      const data = await apiRequest<{ items?: ExecutionRecord[] } | ExecutionRecord[]>(
        "/executions",
      );
      const items = Array.isArray(data) ? data : data.items ?? [];
      setExecutions(items);
    } catch (error) {
      notify(`Could not load execution history: ${String(error)}`, "error");
    }
  }, [notify]);

  useEffect(() => {
    void refreshWorkflows();
    void refreshExecutions();
  }, [refreshWorkflows, refreshExecutions]);

  const loadWorkflow = async (id: string) => {
    if (!id) {
      setSelectedId("");
      setName("New Automation");
      setDescription("");
      setDefinition(emptyDefinition());
      setSelectedNodeId("");
      setVersions([]);
      return;
    }

    setBusy(true);
    try {
      const workflow = await apiRequest<WorkflowRecord>(`/workflows/${id}`);
      setSelectedId(String(workflow.id));
      setName(workflow.name);
      setDescription(workflow.description ?? "");
      setDefinition(normalizeDefinition(workflow.definition));
      setSelectedNodeId("");
      setActivePanel("nodes");
      notify(`Loaded workflow: ${workflow.name}`, "success");

      try {
        const versionData = await apiRequest<
          { items?: VersionRecord[] } | VersionRecord[]
        >(`/workflows/${id}/versions`);
        setVersions(
          Array.isArray(versionData) ? versionData : versionData.items ?? [],
        );
      } catch {
        setVersions([]);
      }
    } catch (error) {
      notify(`Load failed: ${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const addNode = (type: string, label: string) => {
    const id = `${type}_${Date.now().toString(36)}`;
    const node: WorkflowNode = {
      id,
      type: "default",
      position: { x: 80, y: definition.nodes.length * 120 + 24 },
      data: { label, type, config: {} },
    };

    setDefinition((current) => {
      const previous = current.nodes[current.nodes.length - 1];
      const edge: WorkflowEdge[] = previous
        ? [{ id: `edge_${previous.id}_${id}`, source: previous.id, target: id }]
        : [];

      return {
        nodes: [...current.nodes, node],
        edges: [...current.edges, ...edge],
      };
    });

    setSelectedNodeId(id);
    setActivePanel("nodes");
    notify(`Added ${label}. Save the workflow to persist it.`);
  };

  const deleteNode = (id: string) => {
    setDefinition((current) => ({
      nodes: current.nodes.filter((node) => node.id !== id),
      edges: current.edges.filter(
        (edge) => edge.source !== id && edge.target !== id,
      ),
    }));
    setSelectedNodeId("");
    notify("Node removed. Save to persist changes.");
  };

  const updateNode = (id: string, patch: Partial<WorkflowNode["data"]>) => {
    setDefinition((current) => ({
      ...current,
      nodes: current.nodes.map((node) =>
        node.id === id
          ? { ...node, data: { ...node.data, ...patch } }
          : node,
      ),
    }));
  };

  const saveWorkflow = async () => {
    if (!name.trim()) {
      notify("Enter a workflow name before saving.", "error");
      return;
    }

    setBusy(true);
    try {
      const payload = {
        name: name.trim(),
        description: description.trim(),
        definition,
      };

      if (selectedId) {
        const saved = await apiRequest<WorkflowRecord>(`/workflows/${selectedId}`, {
          method: "PUT",
          body: JSON.stringify(payload),
        });
        setSelectedId(String(saved.id ?? selectedId));
        notify("Workflow saved to backend.", "success");
      } else {
        const saved = await apiRequest<WorkflowRecord>("/workflows", {
          method: "POST",
          body: JSON.stringify(payload),
        });
        setSelectedId(String(saved.id));
        notify("Workflow created and saved to backend.", "success");
      }

      await refreshWorkflows();
      await refreshExecutions();
    } catch (error) {
      notify(`Save failed: ${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const validateWorkflow = async () => {
    if (!selectedId) {
      notify("Save the workflow before validating it.", "error");
      return;
    }

    setBusy(true);
    try {
      const result = await apiRequest<{
        valid?: boolean;
        errors?: string[];
        warnings?: string[];
        message?: string;
      }>(`/workflows/${selectedId}/validate`, { method: "POST" });

      const valid = result.valid ?? false;
      const issues = [
        ...(result.errors ?? []),
        ...(result.warnings ?? []).map((warning) => `Warning: ${warning}`),
      ];
      notify(
        `${valid ? "Validation passed" : "Validation returned issues"}${issues.length ? `: ${issues.join(" | ")}` : result.message ? `: ${result.message}` : "."}`,
        valid ? "success" : "error",
      );
    } catch (error) {
      notify(`Validation failed: ${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const runWorkflow = async () => {
    if (!selectedId) {
      notify("Save the workflow before requesting a run.", "error");
      return;
    }

    setBusy(true);
    try {
      const result = await apiRequest<ExecutionRecord>(
        `/workflows/${selectedId}/run`,
        {
          method: "POST",
          body: JSON.stringify({
            trigger_type: "manual",
            input_data: {},
          }),
        },
      );

      setSelectedExecution(String(result.id));
      setActivePanel("executions");
      notify(
        `Execution request recorded (ID ${result.id}, status ${result.status ?? "queued"}). Live runtime is not connected.`,
        "success",
      );
      await refreshExecutions();
    } catch (error) {
      notify(`Run request failed: ${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  const loadExecutionLogs = async (id: string) => {
    setSelectedExecution(id);
    setActivePanel("logs");

    try {
      const data = await apiRequest<
        { items?: Record<string, unknown>[] } | Record<string, unknown>[]
      >(`/executions/${id}/logs`);

      setExecutionLogs(Array.isArray(data) ? data : data.items ?? []);
    } catch (error) {
      setExecutionLogs([]);
      notify(`Could not load logs: ${String(error)}`, "error");
    }
  };

  const refreshAll = async () => {
    await refreshWorkflows();
    await refreshExecutions();
  };

  const removeWorkflow = async () => {
    if (!selectedId) return;
    if (!window.confirm(`Delete workflow "${name}"? This cannot be undone.`)) return;

    setBusy(true);
    try {
      await apiRequest(`/workflows/${selectedId}`, { method: "DELETE" });
      setSelectedId("");
      setName("New Automation");
      setDescription("");
      setDefinition(emptyDefinition());
      setVersions([]);
      notify("Workflow deleted.", "success");
      await refreshWorkflows();
    } catch (error) {
      notify(`Delete failed: ${String(error)}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="wf-root">
      <header className="wf-header">
        <div className="wf-brand">
          <div className="wf-brand-icon"><Workflow size={21} /></div>
          <div>
            <strong>WORKFLOW STUDIO</strong>
            <span>VISUAL AUTOMATION DESIGNER</span>
          </div>
        </div>

        <div className="wf-header-status">
          <span className={`wf-dot ${apiOnline ? "online" : ""}`} />
          {apiOnline ? "API CONNECTED" : "API DISCONNECTED"}
        </div>

        <button className="wf-icon-btn" onClick={() => void refreshAll()} title="Refresh">
          <RefreshCw size={15} />
        </button>
      </header>

      <div className="wf-toolbar">
        <div className="wf-select-wrap">
          <label htmlFor="wf-existing">WORKFLOW</label>
          <select
            id="wf-existing"
            value={selectedId}
            disabled={busy}
            onChange={(event) => void loadWorkflow(event.target.value)}
          >
            <option value="">+ New workflow</option>
            {workflows.map((workflow) => (
              <option key={workflow.id} value={String(workflow.id)}>
                {workflow.name} · v{workflow.version ?? 1}
              </option>
            ))}
          </select>
        </div>

        <div className="wf-toolbar-actions">
          <button className="wf-btn wf-btn-secondary" onClick={() => void validateWorkflow()} disabled={busy}>
            <ShieldCheck size={15} /> Validate
          </button>
          <button className="wf-btn wf-btn-secondary" onClick={() => void saveWorkflow()} disabled={busy}>
            {busy ? <LoaderCircle size={15} className="wf-spin" /> : <Save size={15} />}
            Save
          </button>
          <button className="wf-btn wf-btn-primary" onClick={() => void runWorkflow()} disabled={busy}>
            <CirclePlay size={16} /> Run request
          </button>
        </div>
      </div>

      <div className="wf-meta">
        <input
          aria-label="Workflow name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Workflow name"
          maxLength={160}
        />
        <input
          aria-label="Workflow description"
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          placeholder="Describe what this workflow should do..."
          maxLength={1000}
        />
      </div>

      <div className="wf-main">
        <aside className="wf-palette">
          <div className="wf-section-title">ACTIVITY LIBRARY</div>
          <p className="wf-muted">Select an activity to add it to the workflow.</p>

          {palette.map(({ type, label, icon: Icon, color }) => (
            <button
              key={type}
              className="wf-palette-item"
              onClick={() => addNode(type, label)}
              disabled={busy}
            >
              <span className="wf-palette-icon" style={{ color, borderColor: `${color}50` }}>
                <Icon size={17} />
              </span>
              <span>{label}</span>
              <Plus size={14} className="wf-palette-plus" />
            </button>
          ))}

          <div className="wf-palette-note">
            <ShieldCheck size={15} />
            <span>Design mode only. Activities are not executed locally.</span>
          </div>
        </aside>

        <section className="wf-canvas-area">
          <div className="wf-canvas-toolbar">
            <span><GitBranch size={14} /> WORKFLOW CANVAS</span>
            <span>{definition.nodes.length} NODES · {definition.edges.length} LINKS</span>
          </div>

          <div className="wf-canvas">
            <div className="wf-canvas-grid" />

            {definition.nodes.length === 0 ? (
              <div className="wf-canvas-empty">
                <div className="wf-empty-symbol"><Workflow size={32} /></div>
                <strong>Build your first workflow</strong>
                <p>Add an activity from the left panel to begin.</p>
                <button className="wf-btn wf-btn-secondary" onClick={() => addNode("trigger", "Manual Trigger")}>
                  <Plus size={15} /> Add trigger
                </button>
              </div>
            ) : (
              <div className="wf-node-list">
                {definition.nodes.map((node, index) => {
                  const meta = palette.find((item) => item.type === node.data?.type);
                  const Icon = meta?.icon ?? Activity;
                  const color = meta?.color ?? "#94a3b8";

                  return (
                    <div key={node.id} className="wf-node-step">
                      {index > 0 && (
                        <div className="wf-node-connector">
                          <span />
                          <ArrowDown size={15} />
                        </div>
                      )}
                      <button
                        className={`wf-node-card ${selectedNodeId === node.id ? "selected" : ""}`}
                        onClick={() => setSelectedNodeId(node.id)}
                      >
                        <span className="wf-node-icon" style={{ color, borderColor: `${color}65` }}>
                          <Icon size={19} />
                        </span>
                        <span className="wf-node-content">
                          <small>STEP {String(index + 1).padStart(2, "0")} · {node.data?.type?.toUpperCase()}</small>
                          <strong>{node.data?.label ?? node.id}</strong>
                          <span>{node.id}</span>
                        </span>
                        <span className="wf-node-check"><Check size={14} /></span>
                      </button>
                    </div>
                  );
                })}
                <button
                  className="wf-add-step"
                  onClick={() => addNode("browser", "Browser Action")}
                >
                  <Plus size={15} /> ADD NEXT STEP
                </button>
              </div>
            )}
          </div>

          <div className={`wf-message wf-message-${messageType}`}>
            {messageType === "error" ? <AlertCircle size={15} /> :
             messageType === "success" ? <Check size={15} /> : <Activity size={15} />}
            <span>{message}</span>
          </div>
        </section>

        <aside className="wf-inspector">
          <div className="wf-section-title">PROPERTIES</div>

          {selectedNode ? (
            <>
              <div className="wf-property-heading">
                <span style={{ color: palette.find((p) => p.type === selectedNode.data.type)?.color ?? "#94a3b8" }}>
                  {(() => {
                    const Icon = palette.find((p) => p.type === selectedNode.data.type)?.icon ?? Activity;
                    return <Icon size={20} />;
                  })()}
                </span>
                <div><strong>{selectedNode.data.label}</strong><small>{selectedNode.data.type}</small></div>
              </div>

              <label className="wf-field-label">Display name</label>
              <input
                className="wf-field"
                value={selectedNode.data.label}
                onChange={(event) => updateNode(selectedNode.id, { label: event.target.value })}
              />

              <label className="wf-field-label">Node ID</label>
              <div className="wf-code-value">{selectedNode.id}</div>

              <label className="wf-field-label">Activity type</label>
              <div className="wf-code-value">{selectedNode.data.type}</div>

              <div className="wf-warning">
                <AlertCircle size={15} />
                <span>Activity configuration and live execution require a connected runtime.</span>
              </div>

              <button
                className="wf-btn wf-btn-danger wf-full"
                onClick={() => deleteNode(selectedNode.id)}
              >
                <Trash2 size={15} /> Remove node
              </button>
            </>
          ) : (
            <div className="wf-inspector-empty">
              <SettingsIcon />
              <strong>No node selected</strong>
              <p>Select a node on the canvas to inspect its properties.</p>
            </div>
          )}

          <div className="wf-inspector-divider" />

          <div className="wf-section-title">WORKFLOW INFO</div>
          <div className="wf-info-row"><span>Workflow ID</span><strong>{selectedId || "Not saved"}</strong></div>
          <div className="wf-info-row"><span>Version</span><strong>{selectedWorkflow?.version ?? "Draft"}</strong></div>
          <div className="wf-info-row"><span>Nodes</span><strong>{definition.nodes.length}</strong></div>
          <div className="wf-info-row"><span>Runtime</span><strong className="wf-neutral">Not connected</strong></div>

          {selectedId && (
            <button className="wf-btn wf-btn-danger wf-full wf-delete-workflow" onClick={() => void removeWorkflow()} disabled={busy}>
              <Trash2 size={14} /> Delete workflow
            </button>
          )}
        </aside>
      </div>

      <section className="wf-history">
        <nav className="wf-history-tabs">
          <button className={activePanel === "nodes" ? "active" : ""} onClick={() => setActivePanel("nodes")}>
            <Workflow size={14} /> Designer
          </button>
          <button className={activePanel === "executions" ? "active" : ""} onClick={() => { setActivePanel("executions"); void refreshExecutions(); }}>
            <Clock size={14} /> Executions ({executions.length})
          </button>
          <button className={activePanel === "versions" ? "active" : ""} onClick={() => setActivePanel("versions")}>
            <History size={14} /> Versions ({versions.length})
          </button>
          <button className={activePanel === "logs" ? "active" : ""} onClick={() => setActivePanel("logs")}>
            <Activity size={14} /> Logs
          </button>
          <span className="wf-history-spacer" />
          {loading && <LoaderCircle size={14} className="wf-spin" />}
        </nav>

        <div className="wf-history-content">
          {activePanel === "executions" && (
            executions.length ? (
              <div className="wf-history-table">
                <div className="wf-history-table-head"><span>ID</span><span>STATUS</span><span>CREATED</span><span>ACTION</span></div>
                {executions.map((execution) => (
                  <div className="wf-history-row" key={execution.id}>
                    <span>#{execution.id}</span>
                    <span className={`wf-exec-status status-${(execution.status ?? "unknown").toLowerCase()}`}>{execution.status ?? "unknown"}</span>
                    <span>{formatDate(execution.created_at)}</span>
                    <button onClick={() => void loadExecutionLogs(String(execution.id))}>View logs</button>
                  </div>
                ))}
              </div>
            ) : <div className="wf-history-empty">No execution records yet. Save a workflow, then select Run request.</div>
          )}

          {activePanel === "versions" && (
            selectedId ? (
              versions.length ? (
                <div className="wf-history-table">
                  <div className="wf-history-table-head"><span>VERSION</span><span>NAME</span><span>CREATED</span><span>DETAIL</span></div>
                  {versions.map((version) => (
                    <div className="wf-history-row" key={version.id}>
                      <span>v{version.version ?? "?"}</span>
                      <span>{version.name ?? name}</span>
                      <span>{formatDate(version.created_at)}</span>
                      <span>{version.description ?? "Saved snapshot"}</span>
                    </div>
                  ))}
                </div>
              ) : <div className="wf-history-empty">No version snapshots returned for this workflow yet. Save changes to create history.</div>
            ) : <div className="wf-history-empty">Save the workflow first to view its versions.</div>
          )}

          {activePanel === "logs" && (
            executionLogs.length ? (
              <div className="wf-log-list">
                {executionLogs.map((log, index) => (
                  <div className="wf-log-line" key={String(log.id ?? index)}>
                    <span>{String(log.level ?? "INFO").toUpperCase()}</span>
                    <span>{String(log.message ?? JSON.stringify(log))}</span>
                    <small>{formatDate(String(log.created_at ?? ""))}</small>
                  </div>
                ))}
              </div>
            ) : (
              <div className="wf-history-empty">
                {selectedExecution ? `No logs returned for execution #${selectedExecution}.` : "Select an execution and choose View logs to inspect its records."}
              </div>
            )
          )}

          {activePanel === "nodes" && (
            <div className="wf-history-empty">
              <ShieldCheck size={15} /> Workflow design is persisted through the backend when you click Save.
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function SettingsIcon() {
  return <ChevronDown size={22} />;
}

export default WorkflowDesigner;
