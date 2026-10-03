// Data behind the "Proyectos" and "Uso" panels. Both are read from the Rust side
// (git, and the Claude Code transcripts) and refreshed on demand: the views call
// these from their per-frame tick, so each one throttles itself.

import { Bridge } from "./bridge";
import { State } from "./state";

const PROJECTS_EVERY_MS = 20_000;
const USAGE_EVERY_MS = 30_000;

let lastProjects = 0;
let lastUsage = 0;

export async function refreshProjects(force = false) {
  const now = Date.now();
  if (!force && now - lastProjects < PROJECTS_EVERY_MS) return;
  lastProjects = now;
  try {
    const found = await Bridge.listProjects();
    if (!found || JSON.stringify(found) === JSON.stringify(State.projects)) return;
    State.projects = found;
    State.notify();
  } catch {
    /* outside Coucou, or git is missing: the panel keeps what it had */
  }
}

export async function refreshUsage(force = false) {
  const now = Date.now();
  if (!force && now - lastUsage < USAGE_EVERY_MS) return;
  lastUsage = now;
  try {
    const found = await Bridge.usageSummary();
    if (!found || JSON.stringify(found) === JSON.stringify(State.usage)) return;
    State.usage = found;
    State.notify();
  } catch {
    /* the panel keeps what it had */
  }
}

/**
 * "Continuar" after a usage limit: resume the conversation in a terminal and tell
 * Claude to carry on. When that cannot be done, open the conversation in the
 * Claude app, and as a last resort a terminal in its folder.
 */
export async function continueSession(id: string, cwd: string | null) {
  if (await Bridge.continueSession(id)) return;
  if (await Bridge.openClaudeSession(id, "resume")) return;
  void Bridge.openInVSCode(cwd);
}
