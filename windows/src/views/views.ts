// Island views — DOM ports of IslandViewContent.swift. Paddings, font sizes,
// colours and wording are copied from the Swift views so both platforms read
// identically.

import { h, svg, clear, dot } from "./dom";
import { ICONS } from "./icons";
import { Ticker } from "./ticker";
import { State, type AgentTask } from "../core/state";
import { washRGBA, type IslandViewName, type Wash } from "../core/layout";
import { createMiniBot, pruneMiniBots } from "../mochi/minibots";
import { buildPrompt } from "./chat";
import { buildChoose, buildUpload, buildUploading } from "./upload";
import { renderIntegrationCard, sessionsCard, type IntegrationCardHooks } from "./integrations";
import { refreshSessions } from "../island/hooks";
import { Bridge } from "../core/bridge";
import { refreshProjects, refreshUsage } from "../core/panels";

export interface ViewActions {
  setView(v: IslandViewName): void;
  collapse(): void;
  setFocus(id: string): void;
  openTerminal(): void;
  /** Opens the focused Claude Code conversation in the Claude app (terminal as fallback). */
  openSession(kind: "resume" | "needs-input"): void;
  /** After a usage limit: resume the stopped conversation and tell Claude to carry on. */
  continueSession(): void;
  /** The ↗ button: opens whatever the focused pill points at. */
  openTarget(): void;
  openUrl(url: string): void;
  decide(d: "allow" | "deny"): void;
  toggleSound(): void;
  setVolume(v: number): void;
  setAutoClose(seconds: number): void;
  openSettingsWindow(): void;
  blip(): void;
}

export interface ViewHost {
  el: HTMLElement;
  sync(): void;
  /** Called when the view becomes active, for views with a text field. */
  focus?(): void;
  /** Called every frame while the view is on screen. */
  tick?(nowMs: number): void;
}

// ── Shared pieces ─────────────────────────────────────────────────────────────

function card(wash: Wash, ...children: (Node | string)[]): HTMLElement {
  const el = h("div", { class: wash ? "card wash" : "card" }, ...children);
  if (wash) el.style.setProperty("--wash", washRGBA(wash));
  return el;
}

function btn(
  label: string,
  kind: "primary" | "secondary",
  onClick: () => void,
  kbd?: string,
): HTMLElement {
  return h(
    "button",
    { class: `btn ${kind}`, onclick: onClick },
    h("span", { text: label }),
    kbd ? h("span", { class: "kbd", text: kbd }) : null,
  );
}

/** AgentWho — coloured dot + task name + grey label. */
function agentWho(task: AgentTask | null, label: string): HTMLElement {
  const row = h("div", { class: "who-row" });
  if (task) {
    row.append(dot(task.color, 8), h("span", { class: "n", text: task.name }));
  }
  row.append(h("span", { text: label }));
  return row;
}

function stack(padLeft: number, padRight: number, ...children: Node[]): HTMLElement {
  const el = h("div", { class: "stack" }, ...children);
  el.style.padding = `4px ${padRight}px 4px ${padLeft}px`;
  return el;
}

// ── Header ────────────────────────────────────────────────────────────────────

export function buildHeader(actions: ViewActions): ViewHost {
  const tabHome = h("button", { class: "tab", title: "Resumen", onclick: () => go("overview") }, svg(ICONS.house, 13));
  const tabChat = h("button", { class: "tab", title: "Preguntar", onclick: () => go("prompt") }, svg(ICONS.bubble, 13));
  const tabDrop = h("button", { class: "tab", title: "Soltar", onclick: () => go("upload") }, svg(ICONS.plus, 13));
  const tabProjects = h("button", { class: "tab", title: "Proyectos", onclick: () => go("projects") }, svg(ICONS.folder, 13));
  const tabUsage = h("button", { class: "tab", title: "Uso", onclick: () => go("usage") }, svg(ICONS.chart, 13));

  const gearBtn = h("button", { title: "Ajustes", onclick: () => go("settings") }, svg(ICONS.gear, 14));
  const soundBtn = h("button", { title: "Silenciar", onclick: () => actions.toggleSound() }, svg(ICONS.speakerOn, 14));

  function go(v: IslandViewName) {
    actions.blip();
    actions.setView(v);
  }

  const el = h(
    "div",
    { id: "header" },
    h("div", { class: "tabs" }, tabHome, tabChat, tabDrop, tabProjects, tabUsage),
    h("div", { class: "header-actions" }, gearBtn, soundBtn),
  );

  return {
    el,
    sync() {
      const v = State.view;
      tabHome.classList.toggle("on", v === "overview" || v === "empty");
      tabChat.classList.toggle("on", v === "prompt");
      tabDrop.classList.toggle("on", v === "upload");
      tabProjects.classList.toggle("on", v === "projects");
      tabUsage.classList.toggle("on", v === "usage");
      gearBtn.classList.toggle("on", v === "settings");
      clear(gearBtn);
      gearBtn.append(svg(v === "settings" ? ICONS.gearFill : ICONS.gear, 14));
      clear(soundBtn);
      soundBtn.append(svg(State.settings.soundEnabled ? ICONS.speakerOn : ICONS.speakerOff, 14));
      el.style.opacity = v === "confused" ? "0" : "1";
    },
  };
}

// ── Overview ──────────────────────────────────────────────────────────────────

function buildOverview(actions: ViewActions): ViewHost {
  const ticker = new Ticker();
  const who = h("div", { class: "who" });
  const tickerBody = h("div", { class: "card-body" }, who, ticker.el);
  const leftBody = h("div", { class: "left-body" });
  const jump = h(
    "button",
    { class: "icon-btn jump", title: "Abrir", onclick: () => actions.openTarget() },
    svg(ICONS.arrowUpRight, 8),
  );
  const left = card(null, leftBody, jump);
  const pills = h("div", { class: "pills" });
  const right = card(null, pills);

  const el = h("div", { class: "view overview" },
    h("div", { class: "left" }, left),
    h("div", { class: "right" }, right),
  );

  let pillIds = "";
  let detailOpen = false;
  let lastFocus: string | null = null;
  let mode: "ticker" | "card" | null = null;
  let cardKey = "";
  let lastMinute = Math.floor(Date.now() / 60000);

  const hooks: IntegrationCardHooks = {
    get detailOpen() {
      return detailOpen;
    },
    openDetail() {
      detailOpen = true;
      cardKey = "";
      State.notify();
    },
    closeDetail() {
      detailOpen = false;
      cardKey = "";
      State.notify();
    },
    openSettings: () => actions.openSettingsWindow(),
  };

  return {
    el,
    tick(nowMs: number) {
      if (mode === "ticker") ticker.tick(nowMs);
      // Picks up conversations started elsewhere while the overview is open.
      void refreshSessions();
      // The "hace 3 min" labels only move if something re-renders them.
      const minute = Math.floor(Date.now() / 60000);
      if (minute !== lastMinute) {
        lastMinute = minute;
        if (mode === "card" && State.sessions.length > 0) State.notify();
      }
    },
    sync() {
      const task = State.focusTask;
      if (task?.id !== lastFocus) {
        lastFocus = task?.id ?? null;
        detailOpen = false;
        cardKey = "";
        mode = null;
      }

      // VS Code with a live Claude Code session keeps the ticker; every other
      // pill shows its own card, exactly like IntegrationCardView.
      const isClaude = task?.id === "integration_claude";
      const liveWork = isClaude && task.state !== "idle" && task.state !== "finished";
      // Nothing running: offer the last conversations instead of an empty ticker.
      const showSessions = isClaude && !liveWork && State.sessions.length > 0;
      const sessionActive =
        isClaude && (task.state !== "idle" || task.steps.length > 0) && !showSessions;

      if (task && showSessions) {
        const key = [
          "sessions", detailOpen,
          State.sessions.map((s) => `${s.id}:${s.status}:${s.detail}:${s.lastSeen}`).join("|"),
          Math.floor(Date.now() / 60000),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(sessionsCard());
        }
      } else if (task && sessionActive) {
        if (mode !== "ticker") {
          clear(leftBody);
          leftBody.append(tickerBody);
          mode = "ticker";
          cardKey = "";
        }
        clear(who);
        who.append(
          dot(task.color, 7),
          h("span", { class: "name", text: task.name }),
          h("span", { class: "tool", text: task.source === "claudeCode" ? "Claude Code" : "n8n" }),
        );
        if (task.steps.length > 1) {
          who.append(h("span", {
            class: "count",
            text: `${Math.min(task.stepIndex + 1, task.steps.length)}/${task.steps.length}`,
          }));
        }
        ticker.sync(task);
      } else if (task) {
        const info = State.integrations[task.id];
        const key = [
          task.id, detailOpen, task.state, task.steps.join("|"),
          info?.loaded, info?.error, info?.configured,
          JSON.stringify(info?.data ?? {}),
        ].join("~");
        if (key !== cardKey) {
          cardKey = key;
          mode = "card";
          clear(leftBody);
          leftBody.append(renderIntegrationCard(task, hooks));
        }
      }

      jump.style.display = detailOpen ? "none" : "";

      const others = State.otherTasks.slice(0, 4);
      const pillKey = others.map((t) => `${t.id}:${t.pillBadge ?? ""}`).join("|");
      if (pillKey !== pillIds) {
        pillIds = pillKey;
        clear(pills);
        for (const t of others) pills.append(buildPill(t, actions));
        pruneMiniBots();
      }
    },
  };
}

function buildPill(task: AgentTask, actions: ViewActions): HTMLElement {
  const label = task.id === "integration_claude" ? "VS Code" : task.name;
  const canvas = createMiniBot(task, 24);
  const pill = h(
    "div",
    { class: "pill", onclick: () => actions.setFocus(task.id) },
    canvas,
    h("span", { class: "lbl", text: label }),
  );
  pill.style.borderColor = `${task.color}24`;
  pill.addEventListener("mouseenter", () => {
    pill.style.background = `${task.color}2e`;
    pill.style.borderColor = `${task.color}8c`;
    pill.style.boxShadow = `0 2px 10px ${task.color}59`;
    (pill.querySelector(".lbl") as HTMLElement).style.color = lighten(task.color, 0.3);
  });
  pill.addEventListener("mouseleave", () => {
    pill.style.background = "";
    pill.style.borderColor = `${task.color}24`;
    pill.style.boxShadow = "";
    (pill.querySelector(".lbl") as HTMLElement).style.color = "";
  });

  if (task.pillBadge) {
    const colors = { approval: "#F5A524", finished: "#22C55E", error: "#F4505E" } as const;
    const icons = { approval: ICONS.bang, finished: ICONS.check, error: ICONS.xmark } as const;
    const inner = h("i", { style: `background:${colors[task.pillBadge]}` }, svg(icons[task.pillBadge], 6, { stroke: task.pillBadge === "finished" ? 3 : 0 }));
    const badge = h("div", { class: "pill-badge" }, inner);
    badge.style.boxShadow = `0 0 4px ${colors[task.pillBadge]}99`;
    pill.append(badge);
  }
  return pill;
}

function lighten(hex: string, amount: number): string {
  const v = parseInt(hex.replace("#", ""), 16);
  const c = [(v >> 16) & 255, (v >> 8) & 255, v & 255].map((x) =>
    Math.min(255, Math.round(x + amount * 255)),
  );
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

// ── Empty ─────────────────────────────────────────────────────────────────────

function buildEmpty(actions: ViewActions): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px;flex-direction:row;align-items:center;gap:16px" },
    h(
      "div",
      { style: "display:flex;flex-direction:column;gap:5px" },
      h("div", { class: "title", text: "Nada en marcha ahora mismo." }),
      h("div", { class: "sub", text: "Suelta un archivo o una ventana, o pregúntame lo que quieras." }),
    ),
    h("div", { class: "grow" }),
    btn("Preguntar a Claude", "primary", () => actions.setView("prompt")),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Approval ──────────────────────────────────────────────────────────────────

function buildApproval(actions: ViewActions): ViewHost {
  const who = h("div");
  const code = h("div", { class: "code" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("amber", stack(116, 16, who, code, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      clear(who);
      const req = State.pendingApproval;
      const queued = State.approvalQueue.length;
      // Whose request this is matters once several sessions can be waiting.
      const owner = State.focusTask && req?.project
        ? { ...State.focusTask, name: req.project }
        : State.focusTask;
      who.append(agentWho(owner, queued > 1 ? `necesita permiso · 1 de ${queued}` : "necesita permiso"));
      // The whole point of approving here rather than in the terminal: this line
      // is the command, the file path or the URL being authorised, not just the
      // name of the tool asking.
      code.textContent = State.pendingApproval?.command || State.pendingApproval?.tool || "…";
      // Two buttons, built once. Rebuilding them between a mouse-down and a
      // mouse-up would swallow the click, and there is nothing left to vary:
      // "Always" is gone until the remembered-rules list exists to back it.
      if (rowKey === "built") return;
      rowKey = "built";
      clear(row);
      row.append(
        btn("Denegar", "secondary", () => actions.decide("deny"), "N"),
        btn("Permitir", "primary", () => actions.decide("allow"), "Y"),
      );
    },
  };
}

// ── Question ──────────────────────────────────────────────────────────────────

function buildQuestion(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("cyan", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code te hace una pregunta"));
      const task = State.focusTask;
      title.textContent = task?.steps.at(-1) ?? "Claude necesita una respuesta.";
      clear(row);
      row.append(
        btn("Abrir conversación", "primary", () => actions.openSession("needs-input")),
        h("div", { class: "sub", text: "Coucou aún no puede responder por ti." }),
      );
    },
  };
}

// ── Error ─────────────────────────────────────────────────────────────────────

function buildError(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title", text: "El workflow se detuvo." });
  const detail = h("div", { class: "detail" });
  const row = h("div", { class: "actions" });
  const el = h("div", { class: "view" }, card("red", stack(116, 16, who, title, detail, row)));
  let rowKey = "";
  return {
    el,
    sync() {
      const task = State.focusTask;
      const isClaude = task?.source !== "n8n";
      const limited = isClaude && (task?.state === "ratelimit" || State.sessions.some((s) => s.status === "limit"));
      clear(who);
      who.append(agentWho(task, isClaude ? "Claude Code" : "n8n"));
      title.textContent = !isClaude
        ? "El workflow se detuvo."
        : limited
          ? "Alcanzaste el límite de uso."
          : "La sesión se detuvo por un error.";
      detail.textContent = task?.steps.at(-1) ?? "Sin detalles disponibles.";
      // Built once per variant: rebuilding buttons between a mouse-down and a
      // mouse-up would swallow the click.
      const key = !isClaude ? "n8n" : limited ? "limit" : "claude";
      if (key === rowKey) return;
      rowKey = key;
      clear(row);
      if (!isClaude) {
        row.append(
          btn("Reintentar", "primary", () => actions.setView(State.defaultView())),
          btn("Abrir en n8n", "secondary", () => actions.openUrl("")),
        );
      } else if (limited) {
        row.append(
          btn("Continuar", "primary", () => actions.continueSession()),
          btn("Abrir conversación", "secondary", () => actions.openSession("resume")),
        );
      } else {
        row.append(
          btn("Abrir conversación", "primary", () => actions.openSession("resume")),
          btn("OK", "secondary", () => actions.collapse()),
        );
      }
    },
  };
}

// ── Finished ──────────────────────────────────────────────────────────────────

function buildFinished(actions: ViewActions): ViewHost {
  const who = h("div");
  const title = h("div", { class: "title" });
  const row = h("div", { class: "actions" },
    btn("Abrir conversación", "primary", () => actions.openSession("resume")),
    btn("OK", "secondary", () => actions.collapse()),
  );
  const el = h("div", { class: "view" }, card("green", stack(116, 16, who, title, row)));
  return {
    el,
    sync() {
      clear(who);
      who.append(agentWho(State.focusTask, "Claude Code terminó"));
      title.textContent = State.focusTask?.steps.at(-1) ?? "Sesión terminada";
    },
  };
}

// ── Confused ──────────────────────────────────────────────────────────────────

function buildConfused(): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 128px" },
    h("div", { class: "title", text: "Demasiados golpes a la vez." }),
    h("div", { class: "sub", text: "Dame un segundo: vuelvo al trabajo en tres segundos." }),
  );
  return { el: h("div", { class: "view" }, card("pink", body)), sync() {} };
}

// ── Note ──────────────────────────────────────────────────────────────────────

function buildNote(): ViewHost {
  const title = h("div", { class: "title" });
  const el = h("div", { class: "view" }, card(null, h("div", { class: "stack", style: "padding:0 18px 0 98px" }, title)));
  return {
    el,
    sync() {
      title.textContent = State.noteMessage ?? "";
    },
  };
}

// ── Projects ──────────────────────────────────────────────────────────────────

const MAX_PROJECT_ROWS = 4;

/** Git repositories of the projects folder; a click starts Claude in one. */
function buildProjects(): ViewHost {
  const head = h("div", { class: "panel-head" });
  const list = h("div", { class: "proj-list" });
  const el = h("div", { class: "view" }, card(null, stack(84, 16, head, list)));
  return {
    el,
    tick() {
      void refreshProjects();
    },
    sync() {
      const all = State.projects;
      clear(head);
      head.append(
        h("b", { text: "Proyectos" }),
        h("span", { text: all.length ? `${all.length} repos · clic para abrir Claude` : "" }),
      );
      clear(list);
      if (all.length === 0) {
        list.append(h("div", { class: "panel-empty", text: "No encuentro repositorios git. Elige la carpeta en Ajustes." }));
        return;
      }
      for (const p of all.slice(0, MAX_PROJECT_ROWS)) {
        const dirty = p.changes > 0;
        const color = dirty ? "#F5A524" : p.behind > 0 ? "#38BDF8" : "#22C55E";
        const status = [
          dirty ? `${p.changes} cambio${p.changes === 1 ? "" : "s"}` : "limpio",
          p.ahead ? `↑${p.ahead}` : "",
          p.behind ? `↓${p.behind}` : "",
        ].filter(Boolean).join(" ");
        const row = h(
          "div",
          { class: "proj-row", title: "Abrir una sesión nueva de Claude en esta carpeta" },
          dot(color, 5),
          h("span", { class: "proj-name", text: p.name }),
          h("span", { class: "proj-branch", text: p.branch }),
          h("span", { class: dirty ? "proj-status dirty" : "proj-status", text: status }),
        );
        row.addEventListener("click", () => void Bridge.openProjectSession(p.path));
        list.append(row);
      }
      if (all.length > MAX_PROJECT_ROWS) {
        list.append(h("div", { class: "panel-more", text: `+${all.length - MAX_PROJECT_ROWS} más` }));
      }
    },
  };
}

// ── Usage ─────────────────────────────────────────────────────────────────────

const WEEKDAY_LETTERS = ["D", "L", "M", "X", "J", "V", "S"];

function money(value: number): string {
  return `$${value.toFixed(value < 10 ? 2 : 0)}`;
}

function tokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)} M`;
  if (n >= 1_000) return `${Math.round(n / 1_000)} k`;
  return String(n);
}

/** Today and the last week: estimated cost at API prices, tokens, and a bar per day. */
function buildUsage(): ViewHost {
  const head = h("div", { class: "panel-head" });
  const stats = h("div", { class: "usage-stats" });
  const bars = h("div", { class: "usage-bars" });
  const el = h(
    "div",
    { class: "view" },
    card(null, stack(84, 16, head, h("div", { class: "usage-body" }, stats, bars))),
  );
  return {
    el,
    tick() {
      void refreshUsage();
    },
    sync() {
      const u = State.usage;
      clear(head);
      head.append(
        h("b", { text: "Uso" }),
        h("span", { text: "estimado a precios de API" }),
      );
      clear(stats);
      clear(bars);
      if (!u) {
        stats.append(h("div", { class: "panel-empty", text: "Calculando…" }));
        return;
      }
      const stat = (label: string, cost: number, detail: string) =>
        h(
          "div",
          { class: "usage-stat" },
          h("span", { class: "usage-label", text: label }),
          h("span", { class: "usage-cost", text: money(cost) }),
          h("span", { class: "usage-detail", text: detail }),
        );
      stats.append(
        stat("Hoy", u.today.cost, `${tokens(u.today.input + u.today.output + u.today.cacheWrite + u.today.cacheRead)} tokens`),
        stat("7 días", u.week.cost, `${u.week.messages} respuestas`),
      );
      const max = Math.max(...u.days.map((d) => d.cost), 0.0001);
      const today = new Date();
      u.days.forEach((d, i) => {
        const date = new Date(today.getTime() - (u.days.length - 1 - i) * 86_400_000);
        const bar = h("div", { class: i === u.days.length - 1 ? "usage-bar today" : "usage-bar" });
        bar.style.height = `${Math.max(4, Math.round((d.cost / max) * 100))}%`;
        bar.title = `${money(d.cost)} · ${tokens(d.tokens)} tokens`;
        bars.append(
          h("div", { class: "usage-col" }, bar, h("span", { text: WEEKDAY_LETTERS[date.getDay()] })),
        );
      });
    },
  };
}

// ── In-island settings ────────────────────────────────────────────────────────

function buildSettings(actions: ViewActions): ViewHost {
  const soundSwitch = h("button", { class: "switch", onclick: () => actions.toggleSound() });
  const volume = h("input", {
    type: "range", min: "0", max: "0.2", step: "0.005",
    oninput: (e: Event) => actions.setVolume(Number((e.target as HTMLInputElement).value)),
  }) as HTMLInputElement;
  const autoLabel = h("span", {});
  const segButtons = [10, 15, 30].map((s) =>
    h("button", { onclick: () => actions.setAutoClose(s) }, `${s}s`),
  );
  const claudeBadge = h("span", { class: "status-badge" });
  const apiBadge = h("span", { class: "status-badge" });

  const rows = h(
    "div",
    { class: "settings-rows" },
    h("div", { class: "settings-row" }, soundSwitch, h("span", { text: "Sonido" }), volume),
    h(
      "div",
      { class: "settings-row" },
      svg(ICONS.timer, 12),
      autoLabel,
      h("div", { class: "seg" }, ...segButtons),
    ),
    h(
      "div",
      { class: "settings-row", style: "gap:14px" },
      claudeBadge,
      apiBadge,
      h("div", { class: "grow" }),
      h("button", {
        class: "link-btn",
        style: "color:#8e939c;font-size:11.5px",
        text: "Ajustes…",
        onclick: () => actions.openSettingsWindow(),
      }),
    ),
  );

  const el = h("div", { class: "view" },
    card(null, h("div", { class: "stack", style: "padding:14px 16px 14px 84px" }, rows)));

  return {
    el,
    sync() {
      const s = State.settings;
      soundSwitch.classList.toggle("on", s.soundEnabled);
      volume.value = String(s.soundVolume);
      volume.style.opacity = s.soundEnabled ? "1" : "0.4";
      autoLabel.textContent = `Cierre auto · ${Math.round(s.autoCloseInterval)}s`;
      segButtons.forEach((b, i) => b.classList.toggle("on", s.autoCloseInterval === [10, 15, 30][i]));
      clear(claudeBadge);
      claudeBadge.append(
        dot(s.hooksInstalled ? "#22C55E" : "#F4505E", 6),
        h("span", { text: "Claude Code" }),
      );
      clear(apiBadge);
      apiBadge.append(dot("#F4505E", 6), h("span", { text: "API" }));
    },
  };
}

// ── Placeholders filled in later stages ───────────────────────────────────────

function buildPlaceholder(title: string, sub: string): ViewHost {
  const body = h(
    "div",
    { class: "stack", style: "padding:0 18px 0 118px" },
    h("div", { class: "title", text: title }),
    h("div", { class: "sub", text: sub }),
  );
  return { el: h("div", { class: "view" }, card(null, body)), sync() {} };
}

// ── Registry ──────────────────────────────────────────────────────────────────

export function buildViews(
  actions: ViewActions,
  onChatHeightChange: () => void,
): Map<IslandViewName, ViewHost> {
  const map = new Map<IslandViewName, ViewHost>();
  map.set("overview", buildOverview(actions));
  map.set("empty", buildEmpty(actions));
  map.set("approval", buildApproval(actions));
  map.set("question", buildQuestion(actions));
  map.set("error", buildError(actions));
  map.set("finished", buildFinished(actions));
  map.set("confused", buildConfused());
  map.set("note", buildNote());
  map.set("settings", buildSettings(actions));
  map.set("projects", buildProjects());
  map.set("usage", buildUsage());
  map.set("prompt", buildPrompt(onChatHeightChange));
  map.set("upload", buildUpload());
  map.set("uploading", buildUploading());
  map.set("choose", buildChoose(actions));
  // Not in the Windows v1: sending a file by email, window attach + web result.
  map.set("mail", buildPlaceholder("El envío por correo no está en esta versión.", ""));
  map.set("searching", buildPlaceholder("Claude está buscando…", ""));
  map.set("result", buildPlaceholder("Resultado", ""));
  return map;
}
