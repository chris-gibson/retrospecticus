import type { Source } from "@retrospecticus/shared";
import type { Logger } from "./scanner.ts";

export interface StatusSnapshot {
  collector_version: string;
  machine: string;
  server_url: string;
  hostname: string;
  platform: string;
  started_at: string;
  uptime_seconds: number;
  /** Null when it cannot be told. */
  service_mode: string | null;
  /** Null until the server has been tried once. */
  server_reachable: boolean | null;
  last_heartbeat_at: string | null;
  last_heartbeat_ok: boolean | null;
  last_scan_at: string | null;
  last_upload_at: string | null;
  last_error: { at: string; message: string } | null;
  sources: { name: Source; root: string; files: number; pending_files: number; bytes_pending: number }[];
}

export interface StatusServer {
  port: number;
  stop(): void;
}

const CSP = "default-src 'none'; style-src 'unsafe-inline'";

export function statusUrl(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

/** systemd marks its services with INVOCATION_ID; elsewhere the mode cannot be told reliably. */
export function serviceMode(env: Record<string, string | undefined>, platform: string): string | null {
  if (platform !== "linux") return null;
  return env.INVOCATION_ID ? "systemd service" : "foreground";
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

export function humanBytes(n: number): string {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${i === 0 || value >= 10 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

export function humanDuration(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor((seconds % 86400) / 3600)}h`;
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "never";
  return `${humanDuration(Math.max(0, Math.round((now - Date.parse(iso)) / 1000)))} ago (${iso})`;
}

export function renderStatusHtml(snapshot: StatusSnapshot, now = Date.now()): string {
  const rows: [string, string][] = [
    ["Collector", `${snapshot.collector_version} on ${snapshot.platform}`],
    ["Machine", `${snapshot.machine} (${snapshot.hostname})`],
    ["Server", snapshot.server_url],
    [
      "Reachable",
      snapshot.server_reachable === null ? "not tried yet" : snapshot.server_reachable ? "yes" : "no, retrying with backoff",
    ],
    ["Uptime", humanDuration(snapshot.uptime_seconds)],
    ...(snapshot.service_mode ? ([["Running as", snapshot.service_mode]] as [string, string][]) : []),
    [
      "Last heartbeat",
      snapshot.last_heartbeat_at
        ? `${ago(snapshot.last_heartbeat_at, now)}${snapshot.last_heartbeat_ok === false ? ", failed" : ""}`
        : "none sent yet",
    ],
    ["Last scan", ago(snapshot.last_scan_at, now)],
    ["Last upload", ago(snapshot.last_upload_at, now)],
  ];
  const detail = rows.map(([k, v]) => `<dt>${escapeHtml(k)}</dt><dd>${escapeHtml(v)}</dd>`).join("");
  const error = snapshot.last_error
    ? `<p class="warn">Last error ${escapeHtml(ago(snapshot.last_error.at, now))}: ${escapeHtml(snapshot.last_error.message)}</p>`
    : `<p class="ok">No errors since start.</p>`;
  const sources = snapshot.sources
    .map(
      (s) =>
        `<tr><td>${escapeHtml(s.name)}<br><code>${escapeHtml(s.root)}</code></td><td>${s.files}</td><td>${s.pending_files}</td><td>${humanBytes(s.bytes_pending)}</td></tr>`,
    )
    .join("");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Retrospecticus collector</title>
<style>
:root { color-scheme: light dark; --bg: #fff; --fg: #1d1d1f; --muted: #6b6b70; --line: #d9d9de; --warn-bg: #fff1d6; --warn-fg: #6b4300; --ok: #1b7f3b; }
@media (prefers-color-scheme: dark) { :root { --bg: #17171a; --fg: #ececf0; --muted: #9a9aa3; --line: #34343a; --warn-bg: #3d2f12; --warn-fg: #ffd68a; --ok: #5fcf80; } }
body { background: var(--bg); color: var(--fg); font: 15px/1.5 system-ui, sans-serif; margin: 0 auto; max-width: 760px; padding: 16px; }
h1 { font-size: 20px; margin: 0 0 12px; } h2 { font-size: 16px; margin: 20px 0 8px; }
dl { display: grid; grid-template-columns: max-content 1fr; gap: 4px 16px; margin: 0; }
dt { color: var(--muted); } dd { margin: 0; overflow-wrap: anywhere; }
table { border-collapse: collapse; width: 100%; } th, td { text-align: left; padding: 6px 8px 6px 0; border-bottom: 1px solid var(--line); vertical-align: top; }
code { color: var(--muted); font-size: 12px; overflow-wrap: anywhere; }
.warn { background: var(--warn-bg); color: var(--warn-fg); border-radius: 6px; padding: 8px 10px; overflow-wrap: anywhere; }
.ok { color: var(--ok); }
footer { color: var(--muted); font-size: 12px; margin-top: 20px; }
</style></head><body>
<h1>Retrospecticus collector</h1>
<dl>${detail}</dl>
${error}
<h2>Sources</h2>
<table><thead><tr><th>Source</th><th>Files</th><th>Pending files</th><th>Pending</th></tr></thead><tbody>${sources}</tbody></table>
<footer>Read-only, local to this machine. Refreshes every 10 seconds.</footer>
</body></html>`;
}

/**
 * Serves the snapshot on 127.0.0.1 only. The page is optional, so a port that
 * cannot be bound is reported once and the collector carries on without it.
 */
export function startStatusServer(
  snapshot: () => StatusSnapshot,
  port: number,
  log: Logger,
): StatusServer | null {
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const allowed = [`127.0.0.1:${server.port}`, `localhost:${server.port}`];
        const headers = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };
        // A foreign Host means the request was steered here by a rebinding page, not typed by the user.
        if (!allowed.includes(req.headers.get("host") ?? "")) return new Response("Forbidden\n", { status: 403, headers });
        if (req.method !== "GET" && req.method !== "HEAD") {
          return new Response("Method not allowed\n", { status: 405, headers: { ...headers, Allow: "GET, HEAD" } });
        }
        const path = new URL(req.url).pathname;
        if (path === "/status.json") {
          return Response.json(snapshot(), { headers: { ...headers, "Content-Security-Policy": CSP } });
        }
        if (path === "/") {
          return new Response(renderStatusHtml(snapshot()), {
            headers: { ...headers, "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP },
          });
        }
        return new Response("Not found\n", { status: 404, headers });
      },
      error() {
        return new Response("Internal error\n", { status: 500 });
      },
    });
  } catch (err) {
    log.warn(`status page not started on 127.0.0.1:${port}: ${(err as Error).message}`);
    return null;
  }
  const bound = server.port!;
  log.info(`status page at ${statusUrl(bound)}`);
  return { port: bound, stop: () => void server.stop(true) };
}
