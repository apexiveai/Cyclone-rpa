import { useCallback, useEffect, useMemo, useState } from "react";
import Editor from "@monaco-editor/react";
import {
  Activity, AppWindow, Bot, BrainCircuit, Check, ChevronDown,
  ChevronRight, Clock3, Code2, Cpu,
  FileCode2, FilePlus2, FileText, Folder, GitBranch, Globe,
  LayoutDashboard, LoaderCircle, Maximize2, Minus,
  Plus, Radio, RefreshCw, Rocket, Settings2,
  ShieldCheck, Sparkles, Workflow, X, Zap,
} from "lucide-react";
import WorkflowDesigner from "./WorkflowDesigner";
import "./App.css";

const API = "http://127.0.0.1:8025/api/v1";

type WorkspaceFile = {
  id: string;
  name: string;
  language: string;
  content: string;
};

type Task = {
  id: number | string;
  name: string;
  status?: string;
  priority?: string;
};

const initialFiles: WorkspaceFile[] = [
  {
    id: "main.py",
    name: "main.py",
    language: "python",
    content: `"""
ApexiveAI RPA Platform
Automation entry point
"""

from typing import Any


def main() -> dict[str, Any]:
    """Validate the workflow configuration."""
    workflow = {
        "name": "New Automation",
        "enabled": False,
        "mode": "validation_only",
    }

    print("ApexiveAI Runtime")
    print("Workflow:", workflow["name"])
    print("Mode:", workflow["mode"])

    return workflow


if __name__ == "__main__":
    main()
`,
  },
  {
    id: "workflow.json",
    name: "workflow.json",
    language: "json",
    content: JSON.stringify(
      {
        name: "New Automation",
        version: "1.0.0",
        enabled: false,
        trigger: { type: "manual" },
        steps: [],
        execution_mode: "validation_only",
      },
      null,
      2,
    ),
  },
  {
    id: "README.md",
    name: "README.md",
    language: "markdown",
    content: `# ApexiveAI RPA Platform

AI-assisted automation development workspace.

## Workspace

- Design workflows visually
- Write automation scripts
- Validate workflow configuration
- Connect registered Robot Agents

## Runtime safety

This workspace does not execute arbitrary scripts locally.
Live automation requires a configured and authorized Robot Agent.
`,
  },
];

const starterPrompts = [
  "ᴄʀᴇᴀᴛᴇ ᴀ ɴᴇᴡ ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ",
  "ᴅᴇꜱɪɢɴ ᴀ ᴡᴏʀᴋꜰʟᴏᴡ",
  "ᴏᴘᴇɴ ᴘʏᴛʜᴏɴ ᴇᴅɪᴛᴏʀ",
  "ɪɴꜱᴘᴇᴄᴛ ʀᴏʙᴏᴛ ᴀɢᴇɴᴛꜱ",
];

function readWorkspace(): WorkspaceFile[] {
  try {
    const saved = localStorage.getItem("apexiveai.ide.files");
    if (saved) {
      const parsed = JSON.parse(saved) as WorkspaceFile[];
      if (Array.isArray(parsed) && parsed.length > 0) return parsed;
    }
  } catch {
    // Recover using the default workspace.
  }
  return initialFiles;
}

function App() {
  const [started, setStarted] = useState(
    () => localStorage.getItem("apexiveai.ide.started") === "true",
  );
  const [prompt, setPrompt] = useState("");
  const [activeView, setActiveView] = useState("explorer");
  const [activeTab, setActiveTab] = useState("main.py");
  const [files, setFiles] = useState<WorkspaceFile[]>(readWorkspace);
  const [bottomPanel, setBottomPanel] = useState("OUTPUT");
  const [panelOpen, setPanelOpen] = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [backendOnline, setBackendOnline] = useState(false);
  const [backendMessage, setBackendMessage] = useState("CONNECTING");
  const [tasks, setTasks] = useState<Task[]>([]);
  const [robots, setRobots] = useState<Record<string, unknown>[]>([]);
  const [logs, setLogs] = useState<string[]>([
    "[SYSTEM] ApexiveAI IDE initialized.",
    "[INFO] Runtime mode: validation only.",
    "[INFO] Waiting for backend connection...",
  ]);
  const [taskName, setTaskName] = useState("");
  const [creatingTask, setCreatingTask] = useState(false);
  const [searchTerm] = useState("");
  const [aiOpen, setAiOpen] = useState(false);
  const [aiPrompt, setAiPrompt] = useState("");
  const [aiResponse, setAiResponse] = useState(
    "ᴡᴇʟᴄᴏᴍᴇ ᴛᴏ ᴀᴘᴇxɪᴠᴇᴀɪ. ᴄʜᴏᴏꜱᴇ ᴀ ᴡᴏʀᴋꜰʟᴏᴡ, ᴏᴘᴇɴ ᴀ ꜱᴄʀɪᴘᴛ, ᴏʀ ᴛᴇʟʟ ᴍᴇ ᴡʜᴀᴛ ʏᴏᴜ ᴡᴀɴᴛ ᴛᴏ ʙᴜɪʟᴅ.",
  );

  const currentFile = useMemo(
    () => files.find((file) => file.id === activeTab) ?? files[0],
    [files, activeTab],
  );

  const addLog = useCallback((message: string) => {
    const stamp = new Date().toLocaleTimeString();
    setLogs((current) => [...current.slice(-199), `[${stamp}] ${message}`]);
  }, []);

  const refreshBackend = useCallback(async () => {
    try {
      const response = await fetch(`${API}/dashboard/summary`, {
        signal: AbortSignal.timeout(4000),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const summary = await response.json();
      setBackendOnline(true);
      setBackendMessage("API ONLINE");

      const taskResponse = await fetch(`${API}/tasks`, {
        signal: AbortSignal.timeout(4000),
      });
      if (taskResponse.ok) {
        const taskData = await taskResponse.json();
        setTasks(Array.isArray(taskData) ? taskData : taskData.items ?? []);
      }

      const robotResponse = await fetch(`${API}/robots`, {
        signal: AbortSignal.timeout(4000),
      });
      if (robotResponse.ok) {
        const robotData = await robotResponse.json();
        setRobots(Array.isArray(robotData) ? robotData : robotData.items ?? []);
      }

      if (summary) {
        // API status is separate from actual Robot Agent connectivity.
      }
    } catch {
      setBackendOnline(false);
      setBackendMessage("API OFFLINE");
    }
  }, []);

  useEffect(() => {
    void refreshBackend();
    const timer = window.setInterval(() => void refreshBackend(), 15000);
    return () => window.clearInterval(timer);
  }, [refreshBackend]);

  useEffect(() => {
    localStorage.setItem("apexiveai.ide.files", JSON.stringify(files));
  }, [files]);

  const openWorkspace = (view = "explorer") => {
    localStorage.setItem("apexiveai.ide.started", "true");
    setStarted(true);
    setActiveView(view);
    addLog("[WORKSPACE] Developer environment opened.");
  };

  const updateFile = (value: string | undefined) => {
    if (!currentFile) return;
    setFiles((existing) =>
      existing.map((file) =>
        file.id === currentFile.id ? { ...file, content: value ?? "" } : file,
      ),
    );
  };

  const createFile = () => {
    const name = window.prompt("New file name", "automation.py");
    if (!name?.trim()) return;
    const cleanName = name.trim().replace(/[<>:"/\\|?*]/g, "-");
    const id = `${Date.now()}-${cleanName}`;
    const extension = cleanName.split(".").pop()?.toLowerCase();
    const language =
      extension === "py" ? "python" :
      extension === "json" ? "json" :
      extension === "md" ? "markdown" :
      extension === "ts" || extension === "tsx" ? "typescript" :
      extension === "js" || extension === "jsx" ? "javascript" : "plaintext";

    const next: WorkspaceFile = {
      id,
      name: cleanName,
      language,
      content: language === "json" ? "{\n  \n}\n" : "",
    };

    setFiles((existing) => [...existing, next]);
    setActiveTab(id);
    setActiveView("explorer");
    addLog(`[WORKSPACE] Created ${cleanName}`);
  };

  const closeTab = (id: string) => {
    const remaining = files.filter((file) => file.id !== id);
    if (remaining.length === 0) {
      addLog("[INFO] Keep at least one workspace file open.");
      return;
    }
    setFiles(remaining);
    if (activeTab === id) setActiveTab(remaining[0].id);
  };

  const createBackendTask = async () => {
    if (!taskName.trim()) return;
    setCreatingTask(true);
    try {
      const response = await fetch(`${API}/tasks`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: taskName.trim(),
          description: "Created from ApexiveAI IDE",
          priority: "normal",
          status: "pending",
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const task = await response.json();
      setTasks((existing) => [task, ...existing]);
      setTaskName("");
      addLog(`[TASK] Created backend task: ${task.name}`);
    } catch (error) {
      addLog(`[ERROR] Task creation failed: ${String(error)}`);
    } finally {
      setCreatingTask(false);
    }
  };

  const runValidation = () => {
    if (!currentFile) return;
    setBottomPanel("OUTPUT");
    setPanelOpen(true);
    addLog(`[VALIDATION] Inspecting ${currentFile.name}...`);

    if (currentFile.language === "json") {
      try {
        JSON.parse(currentFile.content);
        addLog("[SUCCESS] JSON syntax is valid.");
      } catch (error) {
        addLog(`[ERROR] Invalid JSON: ${String(error)}`);
      }
    } else if (currentFile.language === "python") {
      addLog("[INFO] Python source loaded. This action does not execute code.");
      addLog("[INFO] Runtime execution requires a registered Robot Agent.");
    } else {
      addLog("[INFO] File opened. No code was executed.");
    }
  };

  const submitStartPrompt = () => {
    const value = prompt.trim();
    openWorkspace(value.toLowerCase().includes("workflow") ? "workflow" : "explorer");
    if (value) {
      setAiPrompt(value);
      setAiOpen(true);
      setAiResponse(
        `ᴡᴏʀᴋꜱᴘᴀᴄᴇ ʀᴇᴀᴅʏ. ʏᴏᴜ ᴀꜱᴋᴇᴅ: “${value}”. ᴄʜᴏᴏꜱᴇ ᴛʜᴇ ᴡᴏʀᴋꜰʟᴏᴡ ᴅᴇꜱɪɢɴᴇʀ ᴏʀ ᴏᴘᴇɴ ᴀ ꜱᴄʀɪᴘᴛ ᴛᴏ ᴄᴏɴᴛɪɴᴜᴇ. ɴᴏ ʟɪᴠᴇ ᴀᴜᴛᴏᴍᴀᴛɪᴏɴ ʜᴀꜱ ʙᴇᴇɴ ʀᴜɴ.`,
      );
    }
  };

  const sendAiPrompt = () => {
    if (!aiPrompt.trim()) return;
    setAiResponse(
      `ᴘʀᴏᴍᴘᴛ ʀᴇᴄᴇɪᴠᴇᴅ: “${aiPrompt.trim()}”. ᴛʜɪꜱ ɪᴅᴇ ᴜɪ ɪꜱ ʀᴇᴀᴅʏ ᴛᴏ ᴘᴀꜱꜱ ʀᴇQᴜᴇꜱᴛꜱ ᴛᴏ ᴀ ᴄᴏɴꜰɪɢᴜʀᴇᴅ ᴀɪ ᴘʀᴏᴠɪᴅᴇʀ ᴡʜᴇɴ ᴀɴ ᴀɪ ᴀᴘɪ ɪꜱ ᴄᴏɴꜰɪɢᴜʀᴇᴅ. ɴᴏ ᴀɪ ᴘʀᴏᴠɪᴅᴇʀ ɪꜱ ᴄᴏɴɴᴇᴄᴛᴇᴅ ʙʏ ᴛʜɪꜱ ᴘʀᴏᴛᴏᴛʏᴘᴇ.`,
    );
    addLog("[AI] Prompt captured locally; no external AI request sent.");
    setAiPrompt("");
  };

  if (!started) {
    return (
      <main className="startup-screen">
        <div className="startup-grid" />
        <div className="startup-orb startup-orb-a" />
        <div className="startup-orb startup-orb-b" />
        <div className="startup-scanline" />

        <header className="startup-topbar">
          <div className="brand-lockup">
            <div className="brand-mark"><BrainCircuit size={23} /></div>
            <div>
              <div className="brand-name">APEXIVE<span>AI</span></div>
              <div className="brand-caption">AUTONOMOUS WORKSPACE</div>
            </div>
          </div>
          <div className="startup-top-status">
            <span className={`status-dot ${backendOnline ? "online" : ""}`} />
            {backendMessage}
            <span className="topbar-divider" />
            <span>BUILD 01.26</span>
          </div>
        </header>

        <section className="startup-main">
          <div className="startup-eyebrow">
            <span className="eyebrow-line" />
            INTELLIGENCE / AUTOMATION / CONTROL
            <span className="eyebrow-line" />
          </div>

          <div className="startup-emblem">
            <div className="emblem-ring emblem-ring-outer" />
            <div className="emblem-ring emblem-ring-middle" />
            <div className="emblem-ring emblem-ring-inner" />
            <div className="emblem-core">
              <BrainCircuit size={48} strokeWidth={1.2} />
            </div>
            <span className="emblem-node node-one" />
            <span className="emblem-node node-two" />
            <span className="emblem-node node-three" />
            <span className="emblem-node node-four" />
          </div>

          <p className="startup-kicker">THE NEXT GENERATION OF AUTOMATION</p>
          <h1 className="startup-title">
            THINK <span>BEYOND</span>
            <br />
            <span className="title-outline">AUTOMATION.</span>
          </h1>
          <p className="startup-description">
            One intelligent workspace. Your workflows, agents, and automation logic.
          </p>

          <form
            className="startup-prompt"
            onSubmit={(event) => {
              event.preventDefault();
              submitStartPrompt();
            }}
          >
            <Sparkles size={19} className="prompt-sparkle" />
            <input
              value={prompt}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="ᴛʏᴘᴇ ꜱᴏᴍᴇᴛʜɪɴɢ ᴛᴏ ꜱᴛᴀʀᴛ"
              aria-label="Type something to start"
            />
            <button type="submit" aria-label="Start workspace">
              <Rocket size={18} />
              <span>INITIALIZE</span>
              <ChevronRight size={17} />
            </button>
          </form>

          <div className="startup-shortcuts">
            {starterPrompts.map((item, index) => (
              <button
                key={item}
                onClick={() => {
                  setPrompt(item);
                  openWorkspace(index === 1 ? "workflow" : "explorer");
                }}
              >
                <span className="shortcut-index">0{index + 1}</span>
                {item}
              </button>
            ))}
          </div>
        </section>

        <footer className="startup-footer">
          <span><span className="status-dot online" /> SYSTEM NOMINAL</span>
          <span>AI-ASSISTED DEVELOPMENT ENVIRONMENT</span>
          <span>© APEXIVEAI</span>
        </footer>
      </main>
    );
  }

  return (
    <main className="ide-shell">
      <header className="ide-titlebar">
        <div className="titlebar-brand">
          <div className="mini-brand-mark"><BrainCircuit size={17} /></div>
          <span className="mini-brand-name">APEXIVE<span>AI</span></span>
          <span className="titlebar-product">RPA PLATFORM</span>
        </div>

        <nav className="menubar" aria-label="Main menu">
          {["File", "Edit", "Selection", "View", "Run", "Robot", "Tools", "Help"].map((item) => (
            <button
              key={item}
              onClick={() => {
                if (item === "Run") runValidation();
                else if (item === "View") setPanelOpen((value) => !value);
                else if (item === "Robot") {
                  setActiveView("robots");
                  setActiveTab("");
                } else if (item === "File") createFile();
                else if (item === "Tools") setAiOpen((value) => !value);
                else addLog(`[MENU] ${item} selected.`);
              }}
            >
              {item}
            </button>
          ))}
        </nav>

        <div className="titlebar-actions">
          <span className={`status-pill ${backendOnline ? "is-online" : "is-offline"}`}>
            <span className="status-dot" /> {backendMessage}
          </span>
          <button className="icon-button" title="AI Assistant" onClick={() => setAiOpen((value) => !value)}>
            <Sparkles size={16} />
          </button>
          <button className="icon-button" title="Settings" onClick={() => addLog("[SETTINGS] Configuration panel is not connected yet.")}>
            <Settings2 size={16} />
          </button>
          <button className="icon-button" title="Return to start" onClick={() => setStarted(false)}>
            <Minus size={16} />
          </button>
        </div>
      </header>

      <div className="ide-body">
        <aside className="activity-rail">
          {[
            { id: "explorer", icon: Folder, label: "Explorer" },
            { id: "workflow", icon: Workflow, label: "Workflow Designer" },
            { id: "robots", icon: Bot, label: "Robot Agents" },
            { id: "tasks", icon: Activity, label: "Tasks" },
            { id: "applications", icon: AppWindow, label: "Applications" },
          ].map(({ id, icon: Icon, label }) => (
            <button
              key={id}
              className={`activity-button ${activeView === id ? "active" : ""}`}
              title={label}
              onClick={() => {
                setActiveView(id);
                if (id === "explorer" && !activeTab) setActiveTab(files[0]?.id ?? "");
                addLog(`[VIEW] ${label} opened.`);
              }}
            >
              <Icon size={21} strokeWidth={1.7} />
              {activeView === id && <span className="activity-indicator" />}
            </button>
          ))}
          <div className="activity-spacer" />
          <button className="activity-button" title="AI Assistant" onClick={() => setAiOpen((value) => !value)}>
            <BrainCircuit size={21} />
          </button>
          <button className="activity-button" title="Settings" onClick={() => addLog("[SETTINGS] Settings are not connected to a server yet.")}>
            <Settings2 size={21} />
          </button>
        </aside>

        {sidebarOpen && (
          <aside className="explorer-sidebar">
            <div className="sidebar-heading">
              <span>EXPLORER</span>
              <div>
                <button className="tiny-icon-button" title="New file" onClick={createFile}><FilePlus2 size={15} /></button>
                <button className="tiny-icon-button" title="Collapse sidebar" onClick={() => setSidebarOpen(false)}><ChevronDown size={15} /></button>
              </div>
            </div>

            <button className="workspace-tree-heading">
              <ChevronDown size={14} />
              <Folder size={15} />
              <span>APEXIVEAI-RPA-PLATFORM</span>
            </button>

            <div className="file-tree">
              <div className="tree-section-label">WORKSPACE FILES</div>
              {files
                .filter((file) => file.name.toLowerCase().includes(searchTerm.toLowerCase()))
                .map((file) => (
                  <button
                    key={file.id}
                    className={`file-tree-item ${activeTab === file.id && activeView === "explorer" ? "selected" : ""}`}
                    onClick={() => {
                      setActiveTab(file.id);
                      setActiveView("explorer");
                    }}
                  >
                    {file.language === "python" ? <Code2 size={15} /> :
                     file.language === "json" ? <FileCode2 size={15} /> :
                     <FileText size={15} />}
                    <span>{file.name}</span>
                  </button>
                ))}

              <div className="tree-section-label tree-section-spaced">PLATFORM</div>
              <button className={`file-tree-item ${activeView === "tasks" ? "selected" : ""}`} onClick={() => setActiveView("tasks")}>
                <Activity size={15} /><span>Tasks</span><span className="tree-count">{tasks.length}</span>
              </button>
              <button className={`file-tree-item ${activeView === "robots" ? "selected" : ""}`} onClick={() => setActiveView("robots")}>
                <Bot size={15} /><span>Robot Agents</span><span className="tree-count">{robots.length}</span>
              </button>
              <button className={`file-tree-item ${activeView === "applications" ? "selected" : ""}`} onClick={() => setActiveView("applications")}>
                <AppWindow size={15} /><span>Applications</span>
              </button>
            </div>

            <div className="sidebar-bottom">
              <div className="sidebar-bottom-title"><Radio size={14} /> BACKEND CONNECTION</div>
              <div className="connection-row">
                <span className={`status-dot ${backendOnline ? "online" : ""}`} />
                <span>{backendOnline ? "API reachable" : "API unavailable"}</span>
              </div>
              <div className="connection-url">127.0.0.1:8025</div>
            </div>
          </aside>
        )}

        {!sidebarOpen && (
          <button className="reopen-sidebar" title="Open Explorer" onClick={() => setSidebarOpen(true)}>
            <ChevronRight size={16} />
          </button>
        )}

        <section className="editor-region">
          <div className="editor-tabs">
            {activeView === "explorer" ? (
              <>
                {files.map((file) => (
                  <div key={file.id} className={`editor-tab ${activeTab === file.id ? "active" : ""}`}>
                    <button className="editor-tab-label" onClick={() => setActiveTab(file.id)}>
                      {file.language === "python" ? <Code2 size={14} /> :
                       file.language === "json" ? <FileCode2 size={14} /> :
                       <FileText size={14} />}
                      <span>{file.name}</span>
                    </button>
                    <button className="tab-close" onClick={() => closeTab(file.id)} title="Close tab"><X size={12} /></button>
                  </div>
                ))}
                <button className="add-tab-button" onClick={createFile} title="New file"><Plus size={15} /></button>
              </>
            ) : (
              <div className="editor-tab active">
                {activeView === "workflow" ? <Workflow size={14} /> :
                 activeView === "robots" ? <Bot size={14} /> :
                 activeView === "tasks" ? <Activity size={14} /> :
                 <AppWindow size={14} />}
                <span>{activeView === "workflow" ? "Workflow Designer" :
                  activeView === "robots" ? "Robot Agents" :
                  activeView === "tasks" ? "Task Explorer" : "Applications"}</span>
              </div>
            )}
            <div className="tabs-spacer" />
            <button className="icon-button tab-action" title="Refresh API" onClick={() => void refreshBackend()}><RefreshCw size={14} /></button>
            <button className="icon-button tab-action" title="Toggle Inspector" onClick={() => setInspectorOpen((value) => !value)}><Maximize2 size={14} /></button>
          </div>

          {activeView === "workflow" ? (
            <div className="embedded-workflow"><WorkflowDesigner /></div>
          ) : activeView === "explorer" && currentFile ? (
            <>
              <div className="breadcrumb-bar">
                <Folder size={13} />
                <span>workspace</span><ChevronRight size={12} />
                <span>{currentFile.name}</span>
                <span className="breadcrumb-spacer" />
                <span className="breadcrumb-mode"><ShieldCheck size={12} /> VALIDATION MODE</span>
              </div>
              <div className="monaco-wrap">
                <Editor
                  height="100%"
                  language={currentFile.language}
                  theme="vs-dark"
                  value={currentFile.content}
                  onChange={updateFile}
                  options={{
                    minimap: { enabled: true, scale: 0.8 },
                    fontSize: 14,
                    fontFamily: "'Cascadia Code', 'Consolas', monospace",
                    fontLigatures: true,
                    lineNumbers: "on",
                    renderLineHighlight: "all",
                    scrollBeyondLastLine: false,
                    automaticLayout: true,
                    smoothScrolling: true,
                    cursorBlinking: "smooth",
                    cursorSmoothCaretAnimation: "on",
                    padding: { top: 18, bottom: 18 },
                    wordWrap: "on",
                    tabSize: 4,
                    bracketPairColorization: { enabled: true },
                    guides: { indentation: true, bracketPairs: true },
                  }}
                />
              </div>
            </>
          ) : activeView === "robots" ? (
            <div className="data-view">
              <div className="view-overline"><Bot size={15} /> AGENT MANAGEMENT</div>
              <h1>Robot Agents</h1>
              <p className="view-description">Registered runtime agents reported by the backend.</p>
              <div className="data-summary">
                <div className="metric-card"><span>REGISTERED AGENTS</span><strong>{robots.length}</strong><small>Backend records</small></div>
                <div className="metric-card"><span>API CONNECTION</span><strong className={backendOnline ? "metric-good" : "metric-bad"}>{backendOnline ? "ONLINE" : "OFFLINE"}</strong><small>API only — not agent heartbeat</small></div>
              </div>
              <div className="data-table">
                <div className="table-heading"><span>AGENT</span><span>STATUS</span><span>HOSTNAME</span><span>LAST SEEN</span></div>
                {robots.length ? robots.map((robot, index) => (
                  <div className="table-row" key={String(robot.id ?? index)}>
                    <span>{String(robot.name ?? robot.agent_code ?? `Robot ${index + 1}`)}</span>
                    <span>{String(robot.status ?? "unknown")}</span>
                    <span>{String(robot.hostname ?? "—")}</span>
                    <span>{String(robot.last_seen_at ?? "—")}</span>
                  </div>
                )) : <div className="empty-state"><Bot size={26} /><span>No registered Robot Agents</span><small>Agent registration and heartbeat are not configured in this view.</small></div>}
              </div>
            </div>
          ) : activeView === "tasks" ? (
            <div className="data-view">
              <div className="view-overline"><Activity size={15} /> TASK ORCHESTRATION</div>
              <h1>Task Explorer</h1>
              <p className="view-description">Create and review tasks stored by the ApexiveAI backend.</p>
              <form className="task-create-form" onSubmit={(event) => { event.preventDefault(); void createBackendTask(); }}>
                <input value={taskName} onChange={(event) => setTaskName(event.target.value)} placeholder="Enter a task name..." />
                <button type="submit" disabled={creatingTask || !taskName.trim()}>
                  {creatingTask ? <LoaderCircle size={15} className="spin" /> : <Plus size={15} />} CREATE TASK
                </button>
              </form>
              <div className="data-table">
                <div className="table-heading"><span>TASK</span><span>STATUS</span><span>PRIORITY</span><span>ID</span></div>
                {tasks.length ? tasks.map((task, index) => (
                  <div className="table-row" key={String(task.id ?? index)}>
                    <span>{task.name}</span><span>{task.status ?? "pending"}</span>
                    <span>{task.priority ?? "normal"}</span><span>{String(task.id ?? "—")}</span>
                  </div>
                )) : <div className="empty-state"><Clock3 size={25} /><span>No tasks found</span><small>Create a task above to save it to the backend.</small></div>}
              </div>
            </div>
          ) : (
            <div className="data-view">
              <div className="view-overline"><AppWindow size={15} /> SOLUTION REGISTRY</div>
              <h1>Applications</h1>
              <p className="view-description">Automation applications and solution registry.</p>
              <div className="empty-state large-empty"><AppWindow size={30} /><span>Application registry</span><small>Connect the applications API to display stored records here.</small></div>
            </div>
          )}

          {panelOpen && (
            <section className="bottom-panel">
              <div className="bottom-panel-tabs">
                {["PROBLEMS", "OUTPUT", "DEBUG CONSOLE", "TERMINAL", "EXECUTION LOG"].map((name) => (
                  <button key={name} className={bottomPanel === name ? "active" : ""} onClick={() => setBottomPanel(name)}>
                    {name}
                    {name === "PROBLEMS" && <span className="panel-count">0</span>}
                  </button>
                ))}
                <div className="panel-tab-spacer" />
                <button className="tiny-icon-button" title="Close panel" onClick={() => setPanelOpen(false)}><X size={14} /></button>
              </div>
              <div className="bottom-panel-content">
                {bottomPanel === "PROBLEMS" ? (
                  <div className="panel-empty"><Check size={15} /> No problems detected in the current workspace.</div>
                ) : bottomPanel === "TERMINAL" ? (
                  <div className="terminal-lines">
                    <div><span className="terminal-prompt">apexive@workspace</span> <span className="terminal-path">~</span> <span className="terminal-muted">Interactive terminal is not connected to a shell.</span></div>
                    <div className="terminal-muted">Use Windows CMD for project commands. This panel does not execute operating-system commands.</div>
                  </div>
                ) : (
                  <div className="log-lines">
                    {logs.slice(-50).map((log, index) => (
                      <div key={`${index}-${log}`} className={log.includes("[ERROR]") ? "log-error" : log.includes("[SUCCESS]") ? "log-success" : ""}>
                        <span className="log-index">{String(index + 1).padStart(2, "0")}</span>{log}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          <footer className="ide-statusbar">
            <div className="statusbar-left">
              <span><GitBranch size={12} /> main*</span>
              <span><Radio size={12} /> {backendOnline ? "API CONNECTED" : "API DISCONNECTED"}</span>
              <span><ShieldCheck size={12} /> SAFE MODE</span>
            </div>
            <div className="statusbar-right">
              <span>UTF-8</span><span>CRLF</span><span>{currentFile?.language?.toUpperCase() ?? "WORKSPACE"}</span>
              <span><Zap size={12} /> VALIDATION ONLY</span>
            </div>
          </footer>
        </section>

        {inspectorOpen && (
          <aside className="inspector-panel">
            <div className="inspector-heading"><span>INSPECTOR</span><Settings2 size={15} /></div>
            <div className="inspector-card ai-inspector-card">
              <div className="inspector-card-title"><Sparkles size={15} /> AI WORKSPACE</div>
              <div className="ai-orbit">
                <div className="ai-orbit-ring" />
                <div className="ai-orbit-core"><BrainCircuit size={28} /></div>
                <span className="orbit-dot" />
              </div>
              <div className="ai-state">ASSISTANT READY</div>
              <p>AI provider is not connected. Prompt actions remain local.</p>
              <button className="inspector-action" onClick={() => setAiOpen(true)}>OPEN ASSISTANT <ChevronRight size={14} /></button>
            </div>

            <div className="inspector-section">
              <div className="inspector-section-heading"><Cpu size={14} /> RUNTIME STATUS</div>
              <div className="inspector-property"><span>Backend API</span><span className={backendOnline ? "value-good" : "value-bad"}>{backendOnline ? "Online" : "Offline"}</span></div>
              <div className="inspector-property"><span>Robot Network</span><span className="value-neutral">Unknown</span></div>
              <div className="inspector-property"><span>Execution</span><span className="value-neutral">Idle</span></div>
              <div className="inspector-property"><span>Mode</span><span className="value-good">Safe</span></div>
            </div>

            <div className="inspector-section">
              <div className="inspector-section-heading"><LayoutDashboard size={14} /> WORKSPACE STATS</div>
              <div className="inspector-property"><span>Open files</span><strong>{files.length}</strong></div>
              <div className="inspector-property"><span>Backend tasks</span><strong>{tasks.length}</strong></div>
              <div className="inspector-property"><span>Robot agents</span><strong>{robots.length}</strong></div>
            </div>

            <div className="inspector-section">
              <div className="inspector-section-heading"><Globe size={14} /> CONNECTIVITY</div>
              <div className="connection-indicator">
                <span className={`status-dot ${backendOnline ? "online" : ""}`} />
                <div><strong>Local API</strong><small>127.0.0.1:8025</small></div>
                <button className="tiny-icon-button" onClick={() => void refreshBackend()} title="Refresh"><RefreshCw size={13} /></button>
              </div>
            </div>

            <div className="inspector-bottom-note"><ShieldCheck size={13} /> NO LIVE NETWORK ACTIONS ENABLED</div>
          </aside>
        )}
      </div>

      {aiOpen && (
        <section className="ai-floating-panel">
          <div className="ai-floating-header">
            <div className="ai-floating-icon"><Sparkles size={17} /></div>
            <div><strong>APEXIVE AI</strong><small>WORKSPACE ASSISTANT</small></div>
            <span className="ai-header-spacer" />
            <button className="icon-button" onClick={() => setAiOpen(false)} title="Close assistant"><X size={16} /></button>
          </div>
          <div className="ai-floating-body">
            <div className="ai-message-avatar"><BrainCircuit size={17} /></div>
            <div className="ai-message">{aiResponse}</div>
          </div>
          <form className="ai-chat-input" onSubmit={(event) => { event.preventDefault(); sendAiPrompt(); }}>
            <input value={aiPrompt} onChange={(event) => setAiPrompt(event.target.value)} placeholder="Ask about your workflow..." />
            <button type="submit" disabled={!aiPrompt.trim()}><Sparkles size={16} /></button>
          </form>
          <div className="ai-panel-foot"><span className="status-dot" /> PROVIDER NOT CONNECTED</div>
        </section>
      )}
    </main>
  );
}

export default App;