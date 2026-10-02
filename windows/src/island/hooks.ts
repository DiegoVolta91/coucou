// Claude Code hook events → island state.
// Port of HookServer.processEvent / processPermissionRequest from the macOS app.
// Difference from macOS: no terminal filter. On Windows the hook fires from any
// terminal (Windows Terminal, VS Code, PowerShell…) and all of them are handled.

import { Bridge, onEvent } from "../core/bridge";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import type { Island } from "./island";

const CLAUDE_ID = "integration_claude";

/** One deadline per queued permission request: past it the terminal has taken over. */
const approvalTimers = new Map<string, number>();

/** Drops a request from the queue and returns how many are still waiting. */
export function releaseApproval(requestId: string): number {
  const timer = approvalTimers.get(requestId);
  if (timer != null) window.clearTimeout(timer);
  approvalTimers.delete(requestId);
  State.approvalQueue = State.approvalQueue.filter((a) => a.requestId !== requestId);
  return State.approvalQueue.length;
}

/** Nobody answered in time: stop showing a card that would be lying. */
function expireApproval(island: Island, requestId: string) {
  approvalTimers.delete(requestId);
  if (!State.approvalQueue.some((a) => a.requestId === requestId)) return;
  if (releaseApproval(requestId) === 0) {
    State.isPinned = false;
    island.dropPin();
    State.updateTask(CLAUDE_ID, "working");
    State.setPillBadge(CLAUDE_ID, null);
    if (State.view === "approval") island.setView(State.defaultView());
  }
  State.notify();
}

interface HookPayload {
  hook_event_name?: string;
  request_id?: string;
  session_id?: string;
  cwd?: string;
  message?: string;
  /** Stop carries the assistant's closing text here. */
  last_assistant_message?: string;
  /** UserPromptSubmit carries `prompt`; `message` belongs to Notification/Stop. */
  prompt?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  /** Notification: permission_prompt, idle_prompt, elicitation_dialog… */
  notification_type?: string;
}

const PROJECT_ALIASES: Record<string, string> = {
  "notch-buddy": "Notch Buddy",
  notchbuddy: "Notch Buddy",
  notch_buddy: "Notch Buddy",
};

function aliasProjectName(name: string): string {
  return PROJECT_ALIASES[name.toLowerCase()] ?? name;
}

function lastPathComponent(p: string): string {
  const cleaned = p.replace(/[\\/]+$/, "");
  const idx = Math.max(cleaned.lastIndexOf("\\"), cleaned.lastIndexOf("/"));
  return idx >= 0 ? cleaned.slice(idx + 1) : cleaned;
}

/** frenchStep() — same labels as the macOS app. */
const TOOL_LABELS: Record<string, string> = {
  Bash: "Ejecuta",
  Read: "Lee",
  Write: "Escribe",
  Edit: "Edita",
  Glob: "Busca",
  Grep: "Busca",
  WebSearch: "Búsqueda web",
  WebFetch: "Descarga",
  TodoWrite: "Tareas",
  Task: "Agente",
  LS: "Lista",
  MultiEdit: "Edita",
  NotebookEdit: "Notebook",
  PowerShell: "Ejecuta",
};

function stepLabel(tool: string, input: Record<string, unknown>): string {
  const label = TOOL_LABELS[tool] ?? tool;
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const cmd = str("command");
  if (cmd) return `${label} · ${cmd.slice(0, 40)}`;
  const path = str("path");
  if (path) return `${label} · ${lastPathComponent(path)}`;
  const file = str("file_path");
  if (file) return `${label} · ${lastPathComponent(file)}`;
  const query = str("query");
  if (query) return `${label} · ${query.slice(0, 40)}`;
  return label;
}

/**
 * What the Allow button actually authorises. Approving "Write" tells you nothing
 * — approving `Write · C:\…\.env` tells you everything, and the difference is
 * the whole point of approving from the island rather than blind.
 *
 * Ordered by how specific the field is, so an unfamiliar tool still shows
 * whatever identifying string it carries instead of falling back to its name.
 */
const APPROVAL_FIELDS = [
  "command", // Bash, PowerShell
  "file_path", // Write, Edit, MultiEdit, NotebookEdit
  "path", // Read, LS
  "url", // WebFetch
  "query", // WebSearch
  "pattern", // Glob, Grep
  "prompt", // Task
] as const;

function approvalTarget(tool: string, input: Record<string, unknown>): string {
  for (const field of APPROVAL_FIELDS) {
    const value = input[field];
    if (typeof value === "string" && value.trim()) {
      return `${tool} · ${value.trim()}`;
    }
  }
  return tool;
}

function upsert(projectName: string, cwd: string) {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.name = projectName;
  if (cwd) t.sessionCwd = cwd;
}

function clearSession() {
  const t = State.tasks.find((x) => x.id === CLAUDE_ID);
  if (!t) return;
  t.steps = [];
  t.stepIndex = 0;
  t.name = "VS Code";
  t.pillBadge = null;
}

const firstLine = (text: string | undefined, max: number) =>
  (text ?? "").trim().split(/\r?\n/)[0].slice(0, max);

/** A notification that actually needs a human answer. */
function isQuestion(payload: HookPayload): boolean {
  return (payload.message ?? "").endsWith("?") || payload.notification_type === "elicitation_dialog";
}

/** Keeps the "last conversations" list the overview offers for resuming. */
function trackSession(
  id: string,
  event: string,
  payload: HookPayload,
  projectName: string,
  cwd: string,
) {
  const patch: Parameters<typeof State.touchSession>[1] = { note: undefined };
  if (cwd) {
    patch.cwd = cwd;
    patch.name = projectName;
  }
  switch (event) {
    case "UserPromptSubmit": {
      patch.status = "working";
      const prompt = firstLine(payload.prompt ?? payload.message, 80);
      if (prompt) patch.detail = prompt;
      break;
    }
    case "PreToolUse":
    case "PostToolUse":
    case "PostToolUseFailure":
      patch.status = "working";
      break;
    case "PermissionRequest":
      patch.status = "waiting";
      patch.note = "Pide permiso";
      break;
    case "Notification":
      if (isQuestion(payload)) {
        patch.status = "waiting";
        patch.note = "Espera tu respuesta";
      } else {
        // Not a reason to change what the conversation is doing.
        return;
      }
      break;
    case "Stop": {
      patch.status = "finished";
      const summary = firstLine(payload.last_assistant_message ?? payload.message, 80);
      if (summary) patch.detail = summary;
      break;
    }
    case "SessionEnd":
      patch.status = "ended";
      break;
  }
  State.touchSession(id, patch);
}

const SESSION_REFRESH_MS = 15_000;
let lastSessionRefresh = 0;

/**
 * Fills the conversations list from the transcripts on disk: at startup, and
 * while the overview is on screen. Throttled, so calling it every frame is fine.
 */
export async function refreshSessions(force = false) {
  const now = Date.now();
  if (!force && now - lastSessionRefresh < SESSION_REFRESH_MS) return;
  lastSessionRefresh = now;
  try {
    const found = await Bridge.recentSessions(2);
    if (!found) return;
    State.mergeSessions(
      found.map((s) => ({
        id: s.id,
        cwd: s.cwd,
        name: aliasProjectName(lastPathComponent(s.cwd) || "Session"),
        status: s.status,
        detail: s.detail,
        lastSeen: s.lastSeen,
      })),
    );
  } catch {
    /* outside Coucou, or the transcripts are not there: the list stays as it is */
  }
}

export function registerHookHandlers(island: Island) {
  void refreshSessions(true);
  void onEvent<HookPayload>("hook", (payload) => handleHook(island, payload));
}

function handleHook(island: Island, payload: HookPayload) {
  if (State.paused) {
    // Silence here used to cost Claude Code nearly two minutes: the relay waited
    // for a decision from an island that had already decided not to look. Say so,
    // and the terminal takes the question immediately.
    if (payload.request_id) void Bridge.approvalDecline(payload.request_id);
    return;
  }

  const name = payload.hook_event_name ?? "";
  const cwd = payload.cwd ?? "";
  const raw = lastPathComponent(cwd);
  const projectName = aliasProjectName(raw || "Session");

  if (payload.session_id) {
    const t = State.tasks.find((x) => x.id === CLAUDE_ID);
    if (t) t.sessionId = payload.session_id;
    trackSession(payload.session_id, name, payload, projectName, cwd);
  }
  const focused = State.focusId === CLAUDE_ID;

  /** Alerts force the island open; work events only reveal the compact island. */
  const surface = (view: Parameters<Island["alert"]>[0], isAlert: boolean) => {
    if (State.mode === "expanded") {
      if (isAlert) island.setView(view);
    } else if (isAlert) {
      island.alert(view);
    } else if (State.mode === "hidden") {
      island.reveal();
    }
  };

  switch (name) {
    case "SessionStart":
      upsert(projectName, cwd);
      surface("overview", false);
      Sound.play("work");
      break;

    case "UserPromptSubmit": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "thinking");
      State.setPillBadge(CLAUDE_ID, null);
      // The field is `prompt`; reading `message` meant this step was always blank.
      const asked = payload.prompt ?? payload.message;
      if (asked) State.appendStep(CLAUDE_ID, asked.slice(0, 60));
      surface("overview", false);
      break;
    }

    case "PreToolUse": {
      upsert(projectName, cwd);
      State.updateTask(CLAUDE_ID, "working");
      const tool = payload.tool_name ?? "Tool";
      State.appendStep(CLAUDE_ID, stepLabel(tool, payload.tool_input ?? {}));
      surface("overview", false);
      break;
    }

    case "PostToolUse":
      State.updateTask(CLAUDE_ID, "working");
      break;

    case "PostToolUseFailure":
      State.updateTask(CLAUDE_ID, "working");
      State.appendStep(CLAUDE_ID, "⚠ falló");
      break;

    case "Notification": {
      const message = payload.message ?? "";
      const lower = message.toLowerCase();
      if (lower.includes("rate limit") || lower.includes("limite d")) {
        State.updateTask(CLAUDE_ID, "ratelimit");
        Sound.play("rate");
      } else if (isQuestion(payload)) {
        State.updateTask(CLAUDE_ID, "question");
        State.appendStep(CLAUDE_ID, message);
        Sound.play("question");
        // Same rule as a finished session: the focused agent opens the card, any
        // other one raises its badge and wakes the island so it can be seen.
        if (focused) surface("question", true);
        else {
          State.setPillBadge(CLAUDE_ID, "approval");
          island.reveal();
        }
      }
      break;
    }

    case "Stop":
      State.updateTask(CLAUDE_ID, "finished");
      {
        // Claude Code puts the closing text in `last_assistant_message`; `message`
        // is kept as a fallback for older versions.
        const summary = (payload.last_assistant_message ?? payload.message ?? "").trim();
        if (summary) State.appendStep(CLAUDE_ID, summary.split(/\r?\n/)[0].slice(0, 140));
      }
      Sound.play("finish");
      if (focused) surface("finished", true);
      else State.setPillBadge(CLAUDE_ID, "finished");
      window.setTimeout(() => {
        State.updateTask(CLAUDE_ID, "idle");
        State.setPillBadge(CLAUDE_ID, null);
      }, 5200);
      break;

    case "StopFailure":
      State.updateTask(CLAUDE_ID, "error");
      Sound.play("error");
      if (focused) surface("error", true);
      else State.setPillBadge(CLAUDE_ID, "error");
      break;

    case "SessionEnd":
      State.updateTask(CLAUDE_ID, "idle");
      clearSession();
      break;

    case "SubagentStart":
      State.appendStep(CLAUDE_ID, "+ subagente");
      break;

    case "SubagentStop":
      // It arrives right after Stop; appending would bury the session summary
      // that the finished card shows as its title.
      if (State.tasks.find((x) => x.id === CLAUDE_ID)?.state !== "finished") {
        State.appendStep(CLAUDE_ID, "• subagente listo");
      }
      break;

    case "PermissionRequest": {
      const requestId = payload.request_id ?? "";
      // Requests queue up instead of being sent back to the terminal. The head is
      // the card on screen; each one keeps its own deadline, because the relay
      // gives up on it 110 s after it arrived, whether or not it was ever shown.
      if (State.approvalQueue.some((a) => a.requestId === requestId)) break;
      upsert(projectName, cwd);
      const tool = payload.tool_name ?? "Tool";
      const input = payload.tool_input ?? {};
      State.approvalQueue.push({
        requestId,
        sessionId: payload.session_id ?? "",
        tool,
        command: approvalTarget(tool, input),
        project: projectName,
      });
      // The relay's short ack window closes in 800 ms; the request is in the
      // queue by now, so a human can act on it.
      if (requestId) void Bridge.approvalAck(requestId);
      approvalTimers.set(
        requestId,
        window.setTimeout(() => expireApproval(island, requestId), 110_000),
      );
      if (State.approvalQueue.length > 1) {
        // Already asking: the card just grows a "1 de N", plus a nudge.
        Sound.play("approval");
        break;
      }
      State.updateTask(CLAUDE_ID, "approval");
      State.isPinned = true;
      Sound.play("approval");
      if (focused) {
        island.alert("approval");
      } else {
        // Another agent holds the view, so the card would yank it away. The badge
        // is the signal instead — but it has to be on screen for that to mean
        // anything, hence the reveal. We just told the relay a human can act.
        State.setPillBadge(CLAUDE_ID, "approval");
        island.reveal();
      }
      break;
    }
    default:
      break;
  }
  State.notify();
}
