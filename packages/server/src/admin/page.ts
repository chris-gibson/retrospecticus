import { createHash } from "node:crypto";
import { ADMIN_PAGE_PATH, MCP_PATH } from "@retrospecticus/shared";
import { SETUP_BODY, SETUP_SCRIPT, SETUP_STYLE, SETTINGS_BODY, WIZARD_BODY } from "./page-setup.ts";

const STYLE = `
:root {
  color-scheme: light dark;
  --bg: #f7f7f5; --panel: #ffffff; --text: #1d1d1b; --muted: #6b6b66; --line: #e2e2dc;
  --accent: #2f5bd3; --accent-text: #ffffff; --danger: #b3261e; --warn-bg: #fff4d6; --warn-text: #6b4c00;
  --ok: #1f7a3a; --code-bg: #f0f0ea;
}
@media (prefers-color-scheme: dark) {
  :root {
    --bg: #151515; --panel: #1e1e1e; --text: #ececea; --muted: #a0a09a; --line: #333331;
    --accent: #7c9cf5; --accent-text: #0e0e0e; --danger: #ff8a80; --warn-bg: #3a2f10; --warn-text: #ffd977;
    --ok: #7fd394; --code-bg: #2a2a28;
  }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--text);
  font: 15px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
header { display: flex; align-items: center; justify-content: space-between; gap: 12px;
  padding: 14px 16px; border-bottom: 1px solid var(--line); background: var(--panel); }
header h1 { font-size: 17px; margin: 0; }
main { max-width: 860px; margin: 0 auto; padding: 16px; display: grid; gap: 16px; }
section { background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 16px; min-width: 0; }
h2 { font-size: 15px; margin: 0 0 12px; }
label { display: block; font-weight: 600; margin-bottom: 6px; }
input { font: inherit; color: inherit; background: var(--bg); border: 1px solid var(--line); border-radius: 8px;
  padding: 9px 11px; width: 100%; min-width: 0; }
input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
button { font: inherit; border-radius: 8px; border: 1px solid var(--line); background: var(--bg); color: var(--text);
  padding: 8px 14px; cursor: pointer; white-space: nowrap; }
button.primary { background: var(--accent); border-color: var(--accent); color: var(--accent-text); font-weight: 600; }
button.danger { color: var(--danger); }
button:disabled { opacity: .5; cursor: default; }
.inline { display: flex; gap: 8px; }
.code-input { font: 600 22px/1.2 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .12em;
  text-transform: uppercase; max-width: 14ch; }
.msg { min-height: 1.4em; margin: 8px 0 0; color: var(--muted); }
.msg.error { color: var(--danger); }
.msg.ok { color: var(--ok); }
ul.rows { list-style: none; padding: 0; margin: 12px 0 0; display: grid; gap: 8px; }
ul.rows li { border: 1px solid var(--line); border-radius: 8px; padding: 10px 12px; display: flex; gap: 12px;
  align-items: center; justify-content: space-between; flex-wrap: wrap; }
.row-main { min-width: 0; flex: 1 1 240px; }
.row-title { font-weight: 600; overflow-wrap: anywhere; }
.row-meta { color: var(--muted); font-size: 13px; overflow-wrap: anywhere; }
.warn { background: var(--warn-bg); color: var(--warn-text); border-radius: 6px; padding: 4px 8px; font-size: 13px;
  margin-top: 6px; }
.badge { font-size: 12px; border: 1px solid var(--line); border-radius: 999px; padding: 1px 8px; margin-left: 6px;
  font-weight: 500; color: var(--muted); }
.empty { color: var(--muted); margin: 12px 0 0; }
.secret { margin-top: 12px; padding: 12px; border-radius: 8px; background: var(--code-bg); }
.secret code { display: block; font: 13px ui-monospace, SFMono-Regular, Menlo, monospace; overflow-wrap: anywhere;
  margin: 6px 0 10px; user-select: all; }
.live { font-size: 12px; color: var(--muted); margin-left: auto; display: inline-flex; align-items: center; gap: 6px; }
.live::before { content: ""; width: 8px; height: 8px; border-radius: 50%; background: var(--muted); }
.live.on { color: var(--ok); }
.live.on::before { background: var(--ok); }
#main { display: grid; gap: 16px; }
.tiles { display: grid; grid-template-columns: repeat(auto-fit, minmax(110px, 1fr)); gap: 8px; margin-bottom: 12px; }
.tile { border: 1px solid var(--line); border-radius: 8px; padding: 8px 10px; min-width: 0; }
.tile b { display: block; font-size: 20px; line-height: 1.2; overflow-wrap: anywhere; }
.tile span { color: var(--muted); font-size: 12px; }
.charts { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 12px; margin-bottom: 12px; }
.chart h3, .stats-block h3 { font-size: 13px; margin: 0 0 4px; color: var(--muted); font-weight: 600; }
.chart svg { width: 100%; height: auto; display: block; }
.chart .bar { fill: var(--accent); }
.chart .axis { stroke: var(--line); stroke-width: 1; }
.chart text { fill: var(--muted); font: 10px system-ui, sans-serif; }
.stats-block { margin-top: 12px; min-width: 0; }
.tbl { overflow-x: auto; }
.tbl table { border-collapse: collapse; width: 100%; font-size: 13px; }
.tbl th, .tbl td { text-align: left; padding: 4px 8px 4px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
.tbl th { color: var(--muted); font-weight: 600; white-space: nowrap; }
.tbl td.num, .tbl th.num { text-align: right; font-variant-numeric: tabular-nums; }
.tbl td { overflow-wrap: anywhere; }
.head-row { display: flex; align-items: center; justify-content: space-between; gap: 8px; margin-bottom: 12px; }
.head-row h2 { margin: 0; }
.hidden { display: none !important; }
${SETUP_STYLE}
@media (max-width: 520px) { .inline { flex-wrap: wrap; } .code-input { max-width: none; } }
`;

const SCRIPT = `
"use strict";
const API = ${JSON.stringify(`${ADMIN_PAGE_PATH}/api/`)};
const ADMIN = ${JSON.stringify(ADMIN_PAGE_PATH)};
const MCP = ${JSON.stringify(MCP_PATH)};
const $ = (id) => document.getElementById(id);
let pending = [];
let refreshTimer = null;

function el(tag, props, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined) continue;
    if (k.startsWith("on")) node.addEventListener(k.slice(2), v);
    else if (k === "className") node.className = v;
    else if (k === "value" || k === "checked" || k === "disabled") node[k] = v;
    else node.setAttribute(k, v);
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === "string" ? document.createTextNode(child) : child);
  }
  return node;
}

class SignedOut extends Error {}

async function api(path, body) {
  const init = body === undefined
    ? { credentials: "same-origin" }
    : { method: "POST", credentials: "same-origin", body: JSON.stringify(body),
        headers: { "Content-Type": "application/json", "X-Retrospecticus-Admin": "1" } };
  const res = await fetch(API + path, init);
  let data = null;
  try { data = await res.json(); } catch {}
  if (res.status === 401 && path !== "login") { showLogin(); throw new SignedOut(); }
  if (!res.ok) {
    const err = new Error((data && data.error) || ("Request failed (" + res.status + ")"));
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

function say(id, text, kind) {
  const node = $(id);
  node.textContent = text || "";
  node.className = "msg" + (kind ? " " + kind : "");
}

function report(id, err) {
  if (!(err instanceof SignedOut)) say(id, err.message, "error");
}

function ago(iso) {
  const s = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (s < 60) return s + "s ago";
  if (s < 3600) return Math.floor(s / 60) + "m ago";
  if (s < 86400) return Math.floor(s / 3600) + "h ago";
  return Math.floor(s / 86400) + "d ago";
}

function when(iso) { return iso ? ago(iso) : "never"; }

const SCREENS = ["login", "setup", "wizard", "main"];
function showScreen(name) {
  for (const s of SCREENS) $(s).classList.toggle("hidden", s !== name);
  $("tabs").classList.toggle("hidden", name !== "main");
  $("signout").classList.toggle("hidden", name === "login" || name === "setup");
}

function showLogin() {
  stopRefresh();
  stopLive();
  showScreen("login");
  $("login-token").focus();
}

function showMain() {
  showScreen("main");
  showTab(tabFromHash());
  refreshAll();
  startRefresh();
  startLive();
}

let liveSource = null;
let liveUp = false;
let liveWasDown = false;
let liveRetry = null;
const liveGates = {};
const ALL_TOPICS = ["machines", "enrollments", "stats", "drift", "embedding", "tokens", "settings"];

function setLiveIndicator(state) {
  const node = $("live");
  node.classList.toggle("hidden", state === null);
  node.classList.toggle("on", state === true);
  node.textContent = state === false ? "Reconnecting..." : "Live";
}

function startLive() {
  if (liveSource) return;
  clearTimeout(liveRetry);
  const source = new EventSource(API + "events");
  liveSource = source;
  source.addEventListener("open", () => {
    liveUp = true;
    setLiveIndicator(true);
    // Events sent while the stream was down are gone, so catch up from the server.
    if (liveWasDown) applyChange(new Set(ALL_TOPICS));
    liveWasDown = false;
  });
  source.addEventListener("error", () => {
    liveUp = false;
    liveWasDown = true;
    setLiveIndicator(false);
    // A refused stream (signed out, or too many connections) is not retried by the browser.
    if (source.readyState === EventSource.CLOSED && liveSource === source) {
      liveSource = null;
      api("session").then(() => { liveRetry = setTimeout(startLive, 5000); }, () => {});
    }
  });
  source.addEventListener("change", (event) => {
    let topics = [];
    try { topics = JSON.parse(event.data).topics; } catch {}
    applyChange(new Set(topics));
  });
}

function stopLive() {
  clearTimeout(liveRetry);
  if (liveSource) liveSource.close();
  liveSource = null;
  liveUp = false;
  liveWasDown = false;
  setLiveIndicator(null);
}

// Reloads never overlap and are at least half a second apart, however busy the server is.
function liveLoad(key, load) {
  const gate = liveGates[key] || (liveGates[key] = { busy: false, again: false });
  if (gate.busy) { gate.again = true; return; }
  gate.busy = true;
  Promise.resolve(load()).catch(() => {}).finally(() => setTimeout(() => {
    gate.busy = false;
    if (gate.again) { gate.again = false; liveLoad(key, load); }
  }, 500));
}

function applyChange(topics) {
  const has = (...names) => names.some((n) => topics.has(n));
  if (!$("wizard").classList.contains("hidden")) {
    if (has("enrollments")) liveLoad("pending", loadPending);
    return;
  }
  if ($("main").classList.contains("hidden")) return;
  if (currentTab === "machines") {
    if (has("enrollments")) liveLoad("pending", loadPending);
    if (has("machines")) liveLoad("machines", loadMachines);
  } else if (currentTab === "stats") {
    if (has("stats", "machines", "embedding", "drift")) liveLoad("stats", loadStats);
  } else if (currentTab === "drift") {
    if (has("drift")) liveLoad("drift", loadDrift);
  } else if (currentTab === "tokens") {
    if (has("tokens")) liveLoad("tokens", loadTokens);
  } else if (currentTab === "settings") {
    if (has("settings")) liveLoad("settings", refreshSettingsLive);
    else if (settingsSub === "embedding" && has("embedding")) liveLoad("embedding", loadEmbedding);
  }
}

let currentTab = "machines";
const TABS = ["machines", "stats", "drift", "tokens", "settings"];
function tabFromHash() {
  const name = location.hash.slice(1).split("/")[0];
  return TABS.includes(name) ? name : "machines";
}

function showTab(name) {
  currentTab = name;
  for (const button of $("tabs").querySelectorAll("button")) {
    button.setAttribute("aria-selected", String(button.dataset.tab === name));
  }
  for (const panel of $("main").querySelectorAll("[data-panel]")) {
    panel.classList.toggle("hidden", panel.dataset.panel !== name);
  }
  if (location.hash.slice(1).split("/")[0] !== name) history.replaceState(null, "", ADMIN + "#" + name);
  if (name === "settings") { settingsSub = subFromHash() || settingsSub; loadSettings(); }
  if (name === "stats") loadStats();
  if (name === "drift") loadDrift();
}

function startRefresh() {
  stopRefresh();
  refreshTimer = setInterval(() => {
    if (document.visibilityState === "visible" && !liveUp) loadPending();
  }, 3000);
}

function stopRefresh() {
  if (refreshTimer) clearInterval(refreshTimer);
  refreshTimer = null;
}

function refreshAll() { loadPending(); loadMachines(); loadTokens(); }

function formatCode(raw) {
  const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return chars.length > 4 ? chars.slice(0, 4) + "-" + chars.slice(4) : chars;
}

const SVG = "http://www.w3.org/2000/svg";
function svg(tag, attrs, text) {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs || {})) node.setAttribute(k, String(v));
  if (text !== undefined) node.textContent = text;
  return node;
}

function bytes(n) {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = n, i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return (i === 0 || v >= 10 ? Math.round(v) : v.toFixed(1)) + " " + units[i];
}

function num(n) { return Number(n).toLocaleString(); }

function tile(label, value) {
  return el("div", { className: "tile" }, el("b", {}, value), el("span", {}, label));
}

function barChart(title, unit, days) {
  const W = 300, H = 90, top = 12, bottom = 14, left = 4;
  const max = Math.max(1, ...days.map((d) => d.count));
  const total = days.reduce((a, d) => a + d.count, 0);
  const slot = (W - left) / days.length;
  const plotH = H - top - bottom;
  const label = title + ": " + total + " " + unit + " over the last " + days.length + " days, peak " + max + " in a day";
  const chart = svg("svg", { viewBox: "0 0 " + W + " " + H, role: "img", "aria-label": label });
  chart.append(svg("title", {}, label));
  chart.append(svg("text", { x: left, y: 9 }, "max " + max));
  chart.append(svg("line", { class: "axis", x1: left, x2: W, y1: H - bottom, y2: H - bottom }));
  days.forEach((d, i) => {
    const h = d.count === 0 ? 0 : Math.max(1, (d.count / max) * plotH);
    const bar = svg("rect", { class: "bar", x: left + i * slot + 0.5, y: H - bottom - h, width: Math.max(1, slot - 1), height: h });
    bar.append(svg("title", {}, d.day + ": " + d.count));
    chart.append(bar);
  });
  chart.append(svg("text", { x: left, y: H - 2 }, days[0].day.slice(5)));
  chart.append(svg("text", { x: W, y: H - 2, "text-anchor": "end" }, days[days.length - 1].day.slice(5)));
  return el("div", { className: "chart" }, el("h3", {}, title), chart);
}

function table(title, headers, rows, emptyText) {
  const block = el("div", { className: "stats-block" }, el("h3", {}, title));
  if (!rows.length) { block.append(el("p", { className: "empty" }, emptyText)); return block; }
  const isNum = (c) => typeof c === "number";
  block.append(el("div", { className: "tbl" }, el("table", {},
    el("thead", {}, el("tr", {}, ...headers.map((h, i) => el("th", rows[0][i] !== undefined && isNum(rows[0][i]) ? { className: "num" } : {}, h)))),
    el("tbody", {}, ...rows.map((r) => el("tr", {}, ...r.map((c) =>
      el("td", isNum(c) ? { className: "num" } : {}, isNum(c) ? num(c) : (c === null || c === undefined ? "-" : String(c))))))))));
  return block;
}

async function loadStats() {
  say("stats-msg", "");
  let s;
  try { s = await api("stats"); } catch (err) { return report("stats-msg", err); }
  const lib = s.library;
  const backlog = s.embeddings.backlog;
  $("stats-tiles").replaceChildren(
    tile("sessions", num(lib.sessions.total)), tile("messages", num(lib.messages)), tile("chunks", num(lib.chunks)),
    tile("archive size", bytes(lib.archive_bytes)), tile("database size", bytes(lib.database_bytes + (lib.wal_bytes || 0))),
    tile("embedding backlog", num(backlog)));
  $("stats-charts").replaceChildren(
    barChart("Sessions per day", "sessions", s.activity.sessions_per_day),
    barChart("Searches per day", "searches", s.usage.searches_per_day));
  const sevs = s.health.open_drift.map((d) => d.severity + " " + d.count).join(", ") || "none";
  $("stats-tables").replaceChildren(
    table("By machine", ["Machine", "Sessions", "Messages", "Archive", "Newest session", "Last ingest"],
      lib.machines.map((m) => [m.machine, m.sessions, m.messages, bytes(m.archive_bytes), m.newest_session_started_at && ago(m.newest_session_started_at), when(m.last_ingest_at)]), "No machines yet."),
    table("By source", ["Source", "Sessions", "Messages", "Newest session"],
      lib.sources.map((x) => [x.source, x.sessions, x.messages, x.newest_session_started_at && ago(x.newest_session_started_at)]), "No sessions yet."),
    table("Embedding models", ["Model", "Dims", "Active", "Vectors", "Missing"],
      s.embeddings.models.map((m) => [m.slug, m.dimensions, m.active ? "yes" : "no", m.vectors, m.missing]), "No embedding models."),
    table("Health", ["Check", "Value"], [["Open drift", sevs], ["Quarantined records", s.health.quarantine], ["Unsent alerts", s.health.unsent_alerts]], ""),
    table("Recent alerts", ["Alert", "Severity", "Created", "Sent"],
      s.health.recent_alerts.map((a) => [a.title, a.severity, ago(a.created_at), a.sent_at ? ago(a.sent_at) : "not sent"]), "No alerts."),
    table("Top projects", ["Project", "Sessions"], s.top_projects.map((p) => [p.project_path, p.sessions]), "No projects yet."),
    table("Searches by tool (" + num(s.usage.total_searches) + " total)", ["Tool", "Searches"], s.usage.by_tool.map((t) => [t.tool, t.count]), "No searches yet."),
    table("Recent searches", ["Tool", "Query", "Results", "When"],
      s.usage.recent.map((q) => [q.tool, q.query, q.result_count, ago(q.created_at)]), "No searches yet."));
}

async function loadDrift() {
  let data;
  try { data = await api("drift"); } catch (err) { return report("drift-msg", err); }
  $("drift-events").replaceChildren(...data.events.map((e) => el("li", {},
    el("div", { className: "row-main" },
      el("div", { className: "row-title" }, e.discriminator || "(no type)", el("span", { className: "badge" }, e.severity),
        el("span", { className: "badge" }, e.source)),
      el("div", { className: "row-meta" }, ["version " + (e.harness_version || "unknown"), "seen " + num(e.count) + " times",
        "last " + ago(e.last_seen)].join(" \u00b7 ")),
      e.detail ? el("div", { className: "row-meta" }, e.detail) : null),
    el("div", { className: "inline" },
      e.ignorable ? el("button", { onclick: () => ignoreType(e) }, "Ignore this type") : null,
      el("button", { onclick: () => ackDrift(e) }, "Acknowledge")))));
  $("drift-empty").classList.toggle("hidden", data.events.length > 0);
  const ignored = [];
  for (const source of Object.keys(data.ignore_types)) {
    for (const type of data.ignore_types[source]) ignored.push({ source, type });
  }
  $("drift-ignored").replaceChildren(...ignored.map((i) => el("li", {},
    el("div", { className: "row-main" }, el("div", { className: "row-title" }, i.type, el("span", { className: "badge" }, i.source))),
    el("button", { onclick: () => unignoreType(i) }, "Stop ignoring"))));
  $("drift-ignored-empty").classList.toggle("hidden", ignored.length > 0);
}

async function ackDrift(event) {
  try {
    await api("drift/" + event.id + "/ack", {});
    say("drift-msg", "Acknowledged event " + event.id + ".", "ok");
    loadDrift();
  } catch (err) { report("drift-msg", err); }
}

async function ignoreType(event) {
  const type = event.discriminator.split("[")[0];
  if (!confirm("Treat " + type + " as bookkeeping and stop indexing it? Lines already quarantined will be reparsed.")) return;
  try {
    const res = await api("drift/" + event.id + "/ignore", {});
    say("drift-msg", "Ignoring " + res.type + ". Reparsed " + num(res.reparsed.lines) + " lines (" + num(res.reparsed.messages) +
      " messages); " + num(res.reparsed.quarantined) + " still quarantined.", "ok");
    loadDrift();
  } catch (err) { report("drift-msg", err); }
}

async function unignoreType(entry) {
  if (!confirm("Stop ignoring " + entry.type + "? New lines of this type will raise drift again.")) return;
  try {
    await api("drift/unignore", { source: entry.source, type: entry.type });
    say("drift-msg", "No longer ignoring " + entry.type + ".", "ok");
    loadDrift();
  } catch (err) { report("drift-msg", err); }
}

async function loadPending() {
  try {
    pending = (await api("enrollments")).enrollments;
  } catch (err) { return report("approve-msg", err); }
  const rows = () => pending.map((r) => el("li", {},
    el("div", { className: "row-main" },
      el("div", { className: "row-title" }, r.machine, r.hostname && r.hostname !== r.machine ? el("span", { className: "badge" }, r.hostname) : null),
      el("div", { className: "row-meta" }, [r.platform, r.collector_version && "collector " + r.collector_version,
        r.ip && "from " + r.ip, "requested " + ago(r.created_at)].filter(Boolean).join(" · ")),
      r.existing_machine ? el("div", { className: "warn" },
        "A machine named \\u201c" + r.machine + "\\u201d is already enrolled. Approving gives it another ingest token; make sure this is really that machine.") : null),
    el("button", { className: "danger", onclick: () => deny(r) }, "Deny")));
  $("pending").replaceChildren(...rows());
  $("wiz-pending").replaceChildren(...rows());
  $("pending-empty").classList.toggle("hidden", pending.length > 0);
}

function approveWith(inputId, msgId) {
  return (event) => approve(event, inputId, msgId);
}

async function approve(event, inputId, msgId) {
  event.preventDefault();
  const code = formatCode($(inputId).value);
  if (code.length !== 9) return say(msgId, "Enter all eight characters of the code.", "error");
  let request = pending.find((r) => r.user_code === code);
  if (!request) {
    await loadPending();
    request = pending.find((r) => r.user_code === code);
  }
  if (!request) return say(msgId, "No pending request has that code. Check it, or start enrollment again on the machine.", "error");
  if (request.existing_machine &&
      !confirm("\\u201c" + request.machine + "\\u201d is already enrolled. Approve another token for it anyway?")) return;
  try {
    await api("enrollments/" + request.id + "/approve", { user_code: code });
    $(inputId).value = "";
    say(msgId, "Approved " + request.machine + ". It will pick up its token within a few seconds.", "ok");
    refreshAll();
  } catch (err) { report(msgId, err); }
}

async function deny(request) {
  if (!confirm("Deny the enrollment request from \\u201c" + request.machine + "\\u201d?")) return;
  try {
    await api("enrollments/" + request.id + "/deny", {});
    say("approve-msg", "Denied " + request.machine + ".");
    loadPending();
  } catch (err) { report("approve-msg", err); }
}

async function loadMachines() {
  let machines;
  try { machines = (await api("machines")).machines; } catch (err) { return report("machines-msg", err); }
  $("machines").replaceChildren(...machines.map((m) => {
    let sources = [];
    try { sources = JSON.parse(m.sources || "[]"); } catch {}
    let failure = null;
    try { failure = m.last_error ? JSON.parse(m.last_error) : null; } catch {}
    const stale = failure && !(m.last_upload_at && Date.parse(m.last_upload_at) >= Date.parse(failure.at));
    const where = [m.platform, m.hostname].filter(Boolean).join(" · ");
    return el("li", {}, el("div", { className: "row-main" },
      el("div", { className: "row-title" }, m.machine,
        el("span", { className: "badge" }, m.active_ingest_tokens + " active token" + (m.active_ingest_tokens === 1 ? "" : "s"))),
      el("div", { className: "row-meta" }, [m.collector_version && "collector " + m.collector_version, where].filter(Boolean).join(" · ")),
      el("div", { className: "row-meta" }, ["heartbeat " + when(m.last_heartbeat_at), "upload " + when(m.last_upload_at),
        "ingest " + when(m.last_ingest_at)].join(" · ")),
      sources.length ? el("div", { className: "row-meta" }, sources.map((s) =>
        s.name + ": " + s.files + " files, " + (s.pending_files == null ? "" : s.pending_files + " pending, ") +
        bytes(s.bytes_pending) + " unsent").join(" · ")) : null,
      stale ? el("div", { className: "warn" }, "Collector error " + ago(failure.at) + ": " + failure.message) : null));
  }));
  $("machines-empty").classList.toggle("hidden", machines.length > 0);
}

async function loadTokens() {
  let tokens;
  try { tokens = (await api("tokens")).tokens; } catch (err) { return report("tokens-msg", err); }
  tokens.sort((a, b) => (a.revoked_at ? 1 : 0) - (b.revoked_at ? 1 : 0) || b.id - a.id);
  $("tokens").replaceChildren(...tokens.map((t) => el("li", {},
    el("div", { className: "row-main" },
      el("div", { className: "row-title" }, t.name, el("span", { className: "badge" }, t.scope),
        t.revoked_at ? el("span", { className: "badge" }, "revoked") : null),
      el("div", { className: "row-meta" }, [t.machine && "machine " + t.machine, "created " + ago(t.created_at),
        "last used " + when(t.last_used_at), t.revoked_at && "revoked " + ago(t.revoked_at)].filter(Boolean).join(" · "))),
    t.revoked_at ? null : el("button", { className: "danger", onclick: () => revoke(t) }, "Revoke"))));
}

async function revoke(token) {
  if (!confirm("Revoke \\u201c" + token.name + "\\u201d (" + token.scope + ")? Anything using it stops working immediately.")) return;
  try {
    const res = await api("tokens/" + token.id + "/revoke", {});
    if (res.session_ended) return showLogin();
    say("tokens-msg", "Revoked " + token.name + ".");
    loadTokens(); loadMachines();
  } catch (err) { report("tokens-msg", err); }
}

async function createToken(event) {
  event.preventDefault();
  const name = $("token-name").value.trim();
  if (!name) return say("tokens-msg", "Give the token a name, e.g. the client it is for.", "error");
  try {
    const res = await api("tokens", { scope: "search", name });
    $("token-name").value = "";
    $("new-token-value").textContent = res.token;
    $("new-token").classList.remove("hidden");
    say("tokens-msg", "");
    loadTokens();
  } catch (err) { report("tokens-msg", err); }
}

async function copyFrom(button, source) {
  try {
    await navigator.clipboard.writeText(source.textContent);
    button.textContent = "Copied";
  } catch {
    getSelection().selectAllChildren(source);
    button.textContent = "Press Ctrl+C";
  }
  setTimeout(() => { button.textContent = "Copy"; }, 2000);
}

function copyToken() { return copyFrom($("copy-token"), $("new-token-value")); }

async function login(event) {
  event.preventDefault();
  const button = $("login-button");
  button.disabled = true;
  say("login-msg", "");
  try {
    await api("login", { token: $("login-token").value.trim() });
    $("login-token").value = "";
    showMain();
  } catch (err) { report("login-msg", err); }
  finally { button.disabled = false; }
}

async function logout() {
  try { await api("logout", {}); } catch {}
  $("new-token").classList.add("hidden");
  showLogin();
}

${SETUP_SCRIPT}

$("code").addEventListener("input", (e) => { e.target.value = formatCode(e.target.value); });
$("approve-form").addEventListener("submit", approveWith("code", "approve-msg"));
$("login-form").addEventListener("submit", login);
$("token-form").addEventListener("submit", createToken);
$("copy-token").addEventListener("click", copyToken);
$("dismiss-token").addEventListener("click", () => {
  $("new-token-value").textContent = "";
  $("new-token").classList.add("hidden");
});
$("signout").addEventListener("click", logout);
$("stats-refresh").addEventListener("click", loadStats);
$("drift-refresh").addEventListener("click", loadDrift);
for (const button of $("tabs").querySelectorAll("button")) button.addEventListener("click", () => showTab(button.dataset.tab));
window.addEventListener("hashchange", () => { if (!$("main").classList.contains("hidden")) showTab(tabFromHash()); });
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && refreshTimer) { loadPending(); loadMachines(); loadTokens(); }
});

boot();
`;

const BODY = `
<header>
  <h1>Retrospecticus admin</h1>
  <span id="live" class="live hidden" role="status">Live</span>
  <button id="signout" class="hidden" type="button">Sign out</button>
</header>
<nav id="tabs" class="tabs hidden" aria-label="Sections">
  <button type="button" data-tab="machines">Machines</button>
  <button type="button" data-tab="stats">Stats</button>
  <button type="button" data-tab="drift">Format drift</button>
  <button type="button" data-tab="tokens">Tokens</button>
  <button type="button" data-tab="settings">Settings</button>
</nav>
<main>
${SETUP_BODY}
${WIZARD_BODY}
  <section id="login" class="hidden">
    <h2>Sign in</h2>
    <form id="login-form">
      <label for="login-token">Admin token</label>
      <p class="row-meta">Create one on the server with <code>retrospecticus token create --scope admin</code>.</p>
      <div class="inline">
        <input id="login-token" type="password" autocomplete="off" spellcheck="false" required>
        <button id="login-button" class="primary" type="submit">Sign in</button>
      </div>
      <p id="login-msg" class="msg" role="status"></p>
    </form>
    <p id="login-setup" class="row-meta hidden"><button id="login-to-setup" type="button">First-time setup</button></p>
  </section>
  <div id="main" class="hidden">
    <section data-panel="machines">
      <h2>Add a machine</h2>
      <p class="row-meta">On the machine whose sessions you want to keep, run this. It installs the collector from this server and shows a code to approve here. Raise <code>cleanupPeriodDays</code> in that machine's <code>~/.claude/settings.json</code> first, or Claude Code deletes transcripts older than 30 days.</p>
      <div class="snippet-block">
        <div class="head-row"><h3>On the machine</h3><button id="add-machine-copy" type="button">Copy</button></div>
        <pre class="snippet"><code id="add-machine-cmd"></code></pre>
      </div>
      <form id="approve-form">
        <label for="code">Code shown on the new machine</label>
        <div class="inline">
          <input id="code" class="code-input" inputmode="text" autocomplete="off" autocapitalize="characters"
            spellcheck="false" placeholder="XXXX-XXXX" maxlength="9">
          <button class="primary" type="submit">Approve</button>
        </div>
        <p id="approve-msg" class="msg" role="status"></p>
      </form>
      <ul id="pending" class="rows"></ul>
      <p id="pending-empty" class="empty hidden">No machines are waiting.</p>
    </section>
    <section data-panel="stats">
      <div class="head-row"><h2>Stats</h2><button id="stats-refresh" type="button">Refresh</button></div>
      <p id="stats-msg" class="msg" role="status"></p>
      <div id="stats-tiles" class="tiles"></div>
      <div id="stats-charts" class="charts"></div>
      <div id="stats-tables"></div>
    </section>
    <section data-panel="drift">
      <div class="head-row"><h2>Format drift</h2><button id="drift-refresh" type="button">Refresh</button></div>
      <p id="drift-msg" class="msg" role="status"></p>
      <ul id="drift-events" class="rows"></ul>
      <p id="drift-empty" class="empty hidden">No open drift events.</p>
      <h2 style="margin-top:16px">Ignored record types</h2>
      <ul id="drift-ignored" class="rows"></ul>
      <p id="drift-ignored-empty" class="empty hidden">No record types are being ignored.</p>
    </section>
    <section data-panel="machines">
      <h2>Machines</h2>
      <p id="machines-msg" class="msg" role="status"></p>
      <ul id="machines" class="rows"></ul>
      <p id="machines-empty" class="empty hidden">No machine has reported in yet.</p>
    </section>
    <section data-panel="tokens">
      <h2>Tokens</h2>
      <form id="token-form">
        <label for="token-name">Create search token</label>
        <div class="inline">
          <input id="token-name" placeholder="e.g. laptop MCP client" maxlength="100" autocomplete="off">
          <button class="primary" type="submit">Create</button>
        </div>
      </form>
      <div id="new-token" class="secret hidden">
        <strong>Copy this token now; it will not be shown again.</strong>
        <code id="new-token-value"></code>
        <div class="inline">
          <button id="copy-token" type="button">Copy</button>
          <button id="dismiss-token" type="button">Done</button>
        </div>
      </div>
      <p id="tokens-msg" class="msg" role="status"></p>
      <ul id="tokens" class="rows"></ul>
    </section>
${SETTINGS_BODY}
  </div>
</main>
`;

function cspHash(source: string): string {
  return `'sha256-${createHash("sha256").update(source).digest("base64")}'`;
}

export const ADMIN_PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>Retrospecticus admin</title>
<style>${STYLE}</style>
</head>
<body>
${BODY}
<script>${SCRIPT}</script>
</body>
</html>
`;

export const ADMIN_PAGE_CSP = [
  "default-src 'none'",
  `script-src ${cspHash(SCRIPT)}`,
  `style-src ${cspHash(STYLE)}`,
  "connect-src 'self'",
  "img-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");
