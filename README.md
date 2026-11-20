# Retrospecticus

![A blue yearbook titled Retrospecticus](docs/retrospecticus.png)

A searchable memory for coding agents. Every Claude Code and Codex session from every machine is archived on one home server, indexed there, and made searchable through MCP, so an agent can answer "do you remember when" from what was actually said.

> **Not for the open internet.** Retrospecticus is meant to run on a private network only: your LAN, a VPN such as WireGuard, or an overlay network such as Tailscale. Do not expose it to the internet, directly or through port forwarding, a reverse proxy or a tunnel. It serves plain HTTP with no TLS, its only protection is bearer tokens, and the archive holds everything you and your agents have written, including code, personal conversations and any secrets that appeared in a session. See [Networking](#networking) for how to publish it on one private address.

## What it does

A small collector on each machine pushes new bytes of session files to the server. The server keeps the original files forever, parses and indexes them, and serves search over MCP and a JSON endpoint. It also watches for changes in the session file format and raises an alert when the parser may be missing content.

## Requirements

- The server runs on Linux (x64 or arm64), in Docker (the published image) or directly. It is a single executable with SQLite and `sqlite-vec` built in or alongside; nothing else needs installing.
- **There is no macOS server executable:** on macOS, Bun uses the system SQLite, which cannot load the `sqlite-vec` extension. To host the server on a Mac, run the Docker image (Docker Desktop runs the Linux image, arm64 on Apple Silicon). Collectors run natively on macOS either way.
- Collectors run on Linux and macOS (x64 and arm64), also as single executables.
- A private network that every machine and the server share: a LAN, Tailscale, WireGuard or another overlay. The server speaks plain HTTP and relies on tokens, so it must never be reachable from the internet. See [Networking](#networking).
- Building from source needs Bun 1.4 or newer.

## Running the server with Docker

The image holds only the compiled server executable and `sqlite-vec` on `debian:bookworm-slim` (about 190 MB). It is Debian-based because the executable and `sqlite-vec` need glibc; it will not run on Alpine. Collectors are not containerised; they run on each machine next to the session files.

### Deploy

1. Put `deploy/compose.example.yaml` on the server as `compose.yaml` in a directory of its own (`<deploy-dir>` below). It runs the published image `ghcr.io/chris-gibson/retrospecticus`, built for x64 and arm64 by the release workflow, so nothing is built on the server and no registry login is needed.

   To build the image yourself instead, clone the repository and replace `image:` with `build: ..` as the compose file describes.

2. Create the two host directories and give them to the user the container runs as (`1000:1000` in the compose file; change both together if you want another user):

   ```sh
   sudo mkdir -p /srv/retrospecticus/data
   sudo chown 1000:1000 /srv/retrospecticus/data
   mkdir -m 700 retrospecticus-config && sudo chown 1000:1000 retrospecticus-config
   ```

   - `/srv/retrospecticus/data` is the data directory: the raw archive and the database. Back it up.
   - `retrospecticus-config` holds `config.json` and `secrets.json` (API keys, webhook URLs). It is mounted read-write so the admin page can save settings. Keep it **out** of the data backups, and leave it empty: the server starts on defaults and you configure it in the browser.

3. Next to `compose.yaml`, create `.env` with the address to publish the port on: the server's address on the private network your other machines reach it over (see [Networking](#networking)):

   ```sh
   RETROSPECTICUS_BIND=192.168.1.10
   ```

   This is what keeps the server private: the port is published on that address only, and Compose refuses to start without it. Inside the container the server listens on all interfaces.

4. Start it and open the setup link it prints:

   ```sh
   docker compose up -d
   docker logs retrospecticus
   ```

   ```
   First-time setup: open http://192.168.1.10:7878/admin/setup?code=QWM6-5RZS-6FVV-SD9M
   ```

   The link uses `RETROSPECTICUS_BIND` from `.env` (or, run without Docker on every interface, one line per address of the machine), so it can be clicked as is. If it shows `<this server's address>` instead, an older `compose.yaml` is missing the `environment:` entry; put the address in yourself. To use a DNS name, swap it in for the address. Use the name you want collectors to use: the install command and the address each collector saves come from the address you open the admin page with. Only someone who can read the server's logs has the code, and it stops working once setup is done.

### First-time setup

The setup page walks through:

1. **Your admin token.** Shown once; save it (Copy or Download). It signs you in to `/admin` from then on.
2. **Embeddings.** None (keyword search only), Ollama, oMLX or OpenAI. For Ollama and oMLX, **Find models** lists what is installed and **Test** measures the model's dimensions; oMLX also needs its API key. For OpenAI, paste the API key. See [Embeddings](#embeddings).
3. **Alerts.** Discord and/or email, with **Send test alert**.
4. **Connect agents.** Creates a search token and shows the MCP configuration for Claude Code and Codex with your server's address and the token filled in.
5. **Add your first machine.** Shows the one-line install command for this server (`curl -fsSL http://<server>:7878/install.sh | sh`) and approves the code it prints; see [Enrolling a machine](#enrolling-a-machine). The same command is on the **Machines** tab later.

Every step can be skipped and redone later from **Settings → Run setup again**.

### The admin page

`http://<server>:7878/admin`, signed in with an admin token:

- **Add a machine** (Machines tab): the install command to run on a new machine, and the box to type the code it shows to give it its token.
- **Stats**: sessions, messages and chunks per machine and source, archive and database size, sessions and searches per day, embedding progress, drift, quarantine, alerts, top projects and recent searches.
- **Settings**: every setting in `config.json`, with help text and validation. Changes apply immediately, except the data directory and listen address, which are marked as needing a restart. Secrets are shown only as set or not set and can be replaced or removed, never read back. If someone edited `config.json` by hand since the page loaded, saving is refused rather than overwriting their edit.
- **Machines** and **Tokens**: last upload and heartbeat per machine, with an outdated badge for collectors older than the server and, for machines that allow it, an **Upgrade** button and **Upgrade all outdated (N)** (see [Remote updates](#remote-updates)); list and revoke tokens; create search tokens.

The page updates live over a server-sent event stream (`/admin/api/events`): new enrollment requests, heartbeats, indexing progress and other changes appear without a refresh, including changes made with the CLI in the container. A small Live indicator in the header shows the connection state, and unsaved edits in Settings are never overwritten.

### Command line in the container

The CLI is the same executable. Run it in the running container with `docker exec`; it works on the same database and config the server is using. Every command is listed in the [Command reference](#command-reference).

```sh
alias retrospecticus='docker exec retrospecticus retrospecticus'
retrospecticus doctor
retrospecticus token list
retrospecticus token create --scope admin --name me     # another admin token, e.g. if you lost yours
retrospecticus shapes learn
retrospecticus drift list
docker logs -f retrospecticus
```

`token create` prints the token alone on stdout, so it can be redirected into a file. Secrets read their value from standard input, so pass `-i`:

```sh
docker exec -i retrospecticus retrospecticus secrets set embedding_api_key < openai-key.txt
docker exec retrospecticus retrospecticus secrets list
```

To update, run `docker compose pull && docker compose up -d` in `<deploy-dir>`. The `latest` tag follows each release; pin a version such as `:0.1.0` in `compose.yaml` to update only when you choose.

## Running the server without Docker

Each release has the server for Linux as `retrospecticus-server-linux-x64.tar.gz` and `retrospecticus-server-linux-arm64.tar.gz`: the executable, `sqlite-vec` (`vec0.so`, which must stay beside it), the systemd unit, an example config, `LICENSE` and the third-party notices. Download the one for the server's CPU (`uname -m`: `x86_64` is x64, `aarch64` is arm64), check it and install it:

```sh
v=0.1.1 arch=x64
base=https://github.com/chris-gibson/retrospecticus/releases/download/v$v
curl -fsSLO "$base/retrospecticus-server-linux-$arch.tar.gz" -O "$base/SHA256SUMS"
sha256sum --ignore-missing -c SHA256SUMS
tar -xzf "retrospecticus-server-linux-$arch.tar.gz" && cd "retrospecticus-server-linux-$arch"
sudo install -m 755 retrospecticus /usr/local/bin/retrospecticus
sudo install -m 644 vec0.so /usr/local/bin/vec0.so
```

To build it yourself instead: clone the repository, then `bun install` and `bun scripts/build.ts --collectors none`, which writes `dist/server/retrospecticus` and `dist/server/vec0.so` for the machine you build on. The server runs on Linux only (see [Requirements](#requirements) for macOS).

Create the service user and the config directory, which the user must own so the admin page can save settings:

```sh
sudo useradd --system --home-dir /var/lib/retrospecticus --shell /usr/sbin/nologin retrospecticus
sudo install -d -o retrospecticus -g retrospecticus -m 700 /etc/retrospecticus
echo '{ "listen_host": "<server-address>" }' | sudo -u retrospecticus tee /etc/retrospecticus/config.json
```

`listen_host` defaults to `127.0.0.1` so the server never listens publicly by accident; set it to the server's address on your private network (see [Networking](#networking)). Then install `retrospecticus-server.service` from the package (or `deploy/` in the repository; read it first), start it, and open the setup link from `journalctl -u retrospecticus-server`:

```sh
sudo cp retrospecticus-server.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now retrospecticus-server
```

Run CLI commands as the service user, so they can read the config and the database: `sudo -u retrospecticus retrospecticus doctor`.

## Networking

Retrospecticus does not depend on any particular network. The server is published on one address, and every machine reaches it there: collectors upload to it, agents search it, and you open the admin page on it. Pick the server's address on the private network your machines share.

| Network | `RETROSPECTICUS_BIND` (Docker) or `listen_host` | Machines reach it as |
|---|---|---|
| LAN only | the server's LAN IP, e.g. `192.168.1.10` | `http://192.168.1.10:7878` or a LAN hostname |
| Tailscale | the server's Tailscale IP (`tailscale ip -4`), e.g. `100.101.102.103` | `http://<server>.<tailnet>.ts.net:7878` |
| WireGuard or another overlay | the server's address on that network, e.g. `10.8.0.1` | that address, or a name your DNS gives it |

Open the admin page with the name or address collectors should use: the install command and the address each collector saves come from the address in your browser.

**Starting at boot.** Publishing on one interface's address only works once that interface is up. If Docker (or the server's systemd unit) starts first, the container fails with "cannot assign requested address" and is not retried. Make it wait for whatever provides the address, for example Tailscale:

```sh
sudo systemctl edit docker.service     # or retrospecticus-server.service without Docker
```

```ini
[Unit]
After=tailscaled.service
Wants=tailscaled.service
```

For a LAN address, `After=network-online.target` (already in the server's unit) is usually enough.

**Reaching private names from the server.** The container uses Docker's normal DNS, which resolves internet names (OpenAI, GitHub) but not names only your private network knows, such as a Tailscale name or a hostname your router serves. That matters only when the server itself must reach another private machine, for example Ollama on a GPU box. Options, simplest first:

1. Use the machine's IP address in the setting, e.g. `http://192.168.1.20:11434/v1`.
2. Point the container at your network's resolver, with a public one as a fallback for when it is down:

   ```yaml
       dns:
         - 192.168.1.1          # your router or Pi-hole; 100.100.100.100 for Tailscale
         - 1.1.1.1
   ```

3. Share the host's network with `network_mode: host` (and remove `ports`). The container then uses the host's DNS, whatever network it is on, but loses Docker's network isolation, and the server's `listen_host` setting decides what it listens on.

## Configuration files

The server reads `config.json` (path from `--config`, then `$RETROSPECTICUS_CONFIG`, then `/etc/retrospecticus/config.json`) and `secrets.json` in the same directory. A missing `config.json` means every default. Unknown keys are rejected. The admin page writes both files atomically and keeps the previous config as `config.json.bak`; editing them by hand also works, and the server picks up the change without a restart. `deploy/server.example.json` lists every key:

| Key | Default | Meaning |
|---|---|---|
| `data_dir` | `/var/lib/retrospecticus` | Raw archive and database. Restart to change. |
| `listen_host`, `listen_port` | `127.0.0.1`, `7878` | Where the server listens. Restart to change. |
| `indexer.poll_seconds` | `2` | Seconds between indexer passes. |
| `indexer.yield_min_lines` | `200` | Lines a day needs before the yield monitor judges it. |
| `indexer.chunk_tokens`, `chunk_overlap_tokens` | `400`, `50` | Chunk size for search; see [Ranking](#ranking). |
| `embedding.provider` | `none` | `none`, `ollama`, `omlx` or `openai`. |
| `embedding.model`, `dimensions`, `base_url` | | See [Embeddings](#embeddings). |
| `embedding.query_prefix`, `document_prefix` | per model | Task prompts; see below. |
| `search.keyword_weight`, `vector_weight` | `2`, `1` | Hybrid ranking weights. |
| `downloads.github_repo` | `chris-gibson/retrospecticus` | Where collector releases come from. |
| `alerts.collector_silent_hours` | `48` | Hours without contact before a machine is reported silent. |
| `alerts.embedding_backlog_chunks` | `5000` | Un-embedded chunks that raise an alert. |
| `alerts.digest_hour` | `8` | Hour (0–23) the daily digest is sent. |
| `drift.ignore_types` | `{"claude-code": [], "codex": []}` | Record types (parser discriminators such as `system/stop_hook_summary`, no `[...]` suffix) to treat as bookkeeping and skip. Lines of an unknown type listed here are not quarantined and raise no drift. Normally set with **Ignore this type** on the admin page. |
| `notifiers.discord`, `notifiers.email` | off | See [Alerts](#alerts). |

`secrets.json` (mode 600; the server warns and `doctor` fails if it is readable by others) holds `embedding_api_key`, `omlx_api_key`, `discord_webhook_url`, `smtp_url` and `github_token`. Secrets are read when used, so a changed value applies at once. Set them on the admin page or with `retrospecticus secrets set <name>` (value on standard input), list them with `secrets list` (values are never printed), and remove them with `secrets unset <name>`. They never go in the database or the data directory.

## Enrolling a machine

Do this on every machine whose sessions you want to keep, including the server itself if you use Claude Code or Codex there. The server you just installed hands out the collector, so nothing else needs downloading.

The server fetches the collector from this repository's public GitHub releases on a machine's behalf; no GitHub account or token is needed. (The optional `github_token` secret is only for a private fork: a fine-grained token with read-only **Contents** access to it.)

> **Warning: raise `cleanupPeriodDays` first.** Claude Code deletes transcripts older than `cleanupPeriodDays` (default 30). History older than that is gone before the collector first runs, and nothing can bring it back. On every machine, before anything else, raise it in `~/.claude/settings.json`:
>
> ```json
> {
>   "cleanupPeriodDays": 3650
> }
> ```
>
> If the file already has other settings, add the key to the existing object.

1. **Install and enroll** with one command on the new machine:

   ```sh
   curl -fsSL http://<server>:7878/install.sh | sh
   ```

   It picks the collector for this machine's system and CPU, downloads it through your server, checks its checksum, installs it as `~/.local/bin/retrospecticus-collector` and starts enrollment. It asks for a machine name (default: the hostname) and shows a code:

   ```
   Approve this machine at http://<server>:7878/admin
   Code: WDJB-MJHT   (expires in 10 minutes)
   Waiting for approval...
   ```

   Run the same command on an enrolled machine to update it; it skips enrollment.

2. **Approve it.** On the admin page's **Machines** tab, type the code under **Add a machine** (the request also appears there live, with **Deny** if you don't recognise it). Check it matches the one on the new machine; the page also shows each request's hostname, platform and IP. The collector receives its ingest token and writes `~/.config/retrospecticus/ingest-token` (mode 600) and `~/.config/retrospecticus/collector.json`. No token is copied by hand.

3. **Install the service.** Enroll asks whether to run the collector in the background at login. Yes installs a systemd user unit (Linux) or a launchd agent (Mac) and starts it; the first run uploads all existing history. No prints the exact files and commands so you can do it by hand. `--install` or `--no-install` answers without asking. On Linux, run `loginctl enable-linger $USER` to keep it running while you are logged out.

The server hands out the collector from the GitHub release matching its own version (see [Releases](#releases)). It verifies each download against the release's `SHA256SUMS` before passing it on and caches it, so GitHub is asked once per platform. To skip the script, download the executable from the release (or `http://<server>:7878/downloads/collector/<linux-x64|linux-arm64|darwin-arm64|darwin-x64>`), `chmod +x` it and run `retrospecticus-collector enroll --server http://<server>:7878`. The executables are not signed; on a Mac, a file downloaded through a browser is quarantined, which `xattr -d com.apple.quarantine <file>` clears.

The collector watches `~/.claude/projects` (or `$CLAUDE_CONFIG_DIR/projects`) and `~/.codex/sessions` (or `$CODEX_HOME/sessions`). A source root that does not exist is skipped. It only reads session files; it never changes or deletes them. `deploy/collector.example.json` shows every setting.

While it runs, the collector serves a read-only status page at `http://127.0.0.1:7879/` (JSON at `/status.json`): version, uptime, server reachability, last heartbeat and upload, the last error, and per source the files and bytes still to upload. It listens on the loopback address only, answers only requests addressed to `127.0.0.1` or `localhost`, and never shows the token or file contents. Configure it in `collector.json` with `"status_page": { "enabled": true, "port": 7879 }` (both optional); if the port is taken the collector logs a warning and carries on without the page. The admin page's Machines tab shows the same facts for every machine, from the collector's heartbeat.

Other collector commands:

```sh
retrospecticus-collector status       # config, service, server reachability, running version, status page
retrospecticus-collector install      # (re)install the service for the current config
retrospecticus-collector update       # replace this binary with the server's version and restart the service
retrospecticus-collector remote-update on   # let the server's admin page upgrade this collector (off to stop)
retrospecticus-collector uninstall    # stop and remove the service; --purge also revokes the token and removes config, token and state
retrospecticus-collector run          # run in the foreground
```

`update` asks the server for its version and downloads nothing when the collector is already at it or newer (`--force` installs the server's version anyway). It then checks the version actually running, from the local status page: if that is older than the installed binary, as after a skipped restart, it restarts the service, or says to restart the collector when there is none. When the status page is off or does not answer for this machine, it says it could not check rather than guess. `update` always installs to `~/.local/bin/retrospecticus-collector`, the copy the service runs, and warns when run from another copy. Otherwise it downloads this platform's collector from the server, checks it against `SHA256SUMS`, replaces `~/.local/bin/retrospecticus-collector` and restarts the service. The config and token stay as they are. It refuses to run from source. Rerunning the install command always installs the server's version, without that check, then restarts the service instead of enrolling when the config points at this server and the server still accepts its token. If the server cannot be asked, the script stops rather than enroll a second time. The Machines tab marks a collector older than the server as outdated and gives the command to run on that computer, `<INSTALL_DIR>/retrospecticus-collector update`, with that machine's install directory shown in its details; collectors from before `update` existed get the install command instead. A machine that has turned on remote updates gets an **Upgrade** button instead (see below).

### Remote updates

The Machines tab can upgrade outdated collectors without logging in to each computer. It is opt-in per machine: it lets the server cause new code to run there, so `enroll` asks "Let <server> update this collector from its admin page? [y/N]" (`--remote-update` and `--no-remote-update` answer it without asking). The answer belongs to that server: re-enrolling with the same one keeps it, and enrolling with a different one starts from no. `retrospecticus-collector remote-update on|off` changes it later; the running collector rereads the setting, so it takes effect without a restart. The setting is `"remote_update": true` in `collector.json`, and each heartbeat reports it so the page knows which machines to offer the button for. A machine with it off keeps the `update` command hint, plus the command to turn it on.

**Upgrade** (or **Upgrade all outdated (N)**) queues one update command for each outdated machine that has remote updates on and still has an active token. The server never connects to a collector, so the command waits until the machine's next heartbeat (every 5 minutes by default) and arrives in the answer to it; it is sent again with each heartbeat until it settles, in case an answer is lost, and the collector runs it only once. The collector then runs its own `update` command as a child process, with the same config file. The row shows the command as pending, upgrading, upgraded to a version, or failed with the collector's last output line. A command that is not picked up within 24 hours expires, and one that is delivered but never reported on within 15 minutes is marked failed.

Safety:

- Opt-in: the server refuses to queue or hand out a command for a machine that has not reported the setting on, and the collector checks its config file again before acting on one, and once more before downloading anything.
- Only the server's own version: the command names no URL or version to fetch. The collector downloads from the server it enrolled with, the same as `update` does.
- Checksum verified: the download must match the server's `SHA256SUMS`, as with a manual `update`. That catches a corrupted or truncated download, not tampering: the command, the checksums and the binary all come from your server over the same connection, so remote updates trust your network, as the rest of Retrospecticus does (see the note at the top).
- The swap is atomic, so a machine runs either the old binary or the new one, never half of each. On macOS a failed restart puts the previous binary back and starts it again. On Linux, systemd's restart also ends the update process, so there is no rollback; the previous binary stays as `retrospecticus-collector.prev` until the new version starts, which then removes it.
- One open command per machine, settled only by the enrollment it was sent to, and a collector runs each command once. From source, or with no service installed to restart it, the collector reports why it could not finish instead of leaving the command hanging.

Going back to a collector from 0.1.1 or earlier (for example after rolling the server back): remove `remote_update` from `collector.json` first. Those versions refuse settings they do not know, so they would not start with it there.

`uninstall --purge` first asks the server to revoke this machine's own token (with a warning, and carrying on, if the server is unreachable), then removes the config, token, state, the installed binary, the macOS log, and `~/.config/retrospecticus` and `~/.local/state/retrospecticus` when they are left empty. Sessions already uploaded stay on the server, and the machine shows as retired on the Machines tab once it has no other active ingest token.

Enrolling again (for example with a new server address) updates the existing config in place and restarts the service. It issues a new ingest token without revoking the old one; revoke that on the admin page.

## Connecting agents

The setup wizard shows ready-to-paste configuration. [docs/client-setup.md](docs/client-setup.md) has the details for Claude Code and Codex, the `AGENTS.md` snippet and the optional recall hook.

## Embeddings

Keyword search works with no embeddings and is the default (`"provider": "none"`). Vector search adds matches by meaning. Choose a provider in the setup wizard or under **Settings → Embedding**; **Test** embeds a sample sentence and reports the dimensions and latency. Only redacted chunk text and search queries are sent to the provider; raw transcripts never are. If the provider is down, parsing and keyword search continue and embedding catches up later.

**OpenAI.** Set `"provider": "openai"` and a model, and store the key as the `embedding_api_key` secret:

```json
"embedding": { "provider": "openai", "model": "text-embedding-3-small" }
```

`text-embedding-3-small` is the sensible default; `-large` doubles the vector size (and search time) for a modest gain.

**Ollama**, so nothing leaves your network:

```json
"embedding": {
  "provider": "ollama",
  "model": "embeddinggemma-2",
  "dimensions": 768,
  "base_url": "http://host.docker.internal:11434/v1"
}
```

`dimensions` is required for Ollama models; the wizard measures it. `base_url` defaults to `http://127.0.0.1:11434/v1`, which inside Docker is the container itself. When Ollama runs on the Docker host, use `http://host.docker.internal:11434/v1` with `extra_hosts: ["host.docker.internal:host-gateway"]` in the compose file, and make Ollama listen beyond loopback (`OLLAMA_HOST=0.0.0.0`; keep port 11434 firewalled from everything but the container).

**oMLX** (MLX inference server for Apple Silicon):

```json
"embedding": {
  "provider": "omlx",
  "model": "embeddinggemma-2-bf16",
  "dimensions": 768,
  "base_url": "http://host.docker.internal:8000/v1"
}
```

Unlike Ollama, oMLX needs an API key: it rejects unauthenticated requests by default. Copy it from the oMLX settings (or `auth.api_key` in `~/.omlx/settings.json`) into the API token field in the wizard, or store it with `retrospecticus secrets set omlx_api_key`. It is kept apart from `embedding_api_key`, so switching between OpenAI and oMLX never sends one service's key to the other, and **Find models** and **Test** reuse the saved key only for the oMLX address it was saved with. The wizard, the settings check and `doctor` all treat the key as required. `base_url` defaults to `http://127.0.0.1:8000/v1`; from Docker on macOS use `http://host.docker.internal:8000/v1`. `dimensions` is required in a hand-written config (768 for EmbeddingGemma); the wizard measures it.

EmbeddingGemma models are trained with task prompts, so the server adds them automatically: `task: search result | query: ` before each search and `title: none | text: ` before each chunk. Override them with `query_prefix` and `document_prefix` (`""` turns one off). The document prefix is stored with the model's vectors; if it changes, embedding pauses with an error rather than mixing vectors made two ways. Run `retrospecticus embedding drop <slug>` and the server re-embeds everything with the new prefix, with search on keywords alone until that finishes.

**When the provider fails.** On a rate limit (429) or a server error the request is retried a few times, waiting as long as the provider's `Retry-After` or rate-limit reset headers ask (at most 60 seconds each). If it still fails, embedding pauses and retries on its own: after 30 seconds, then 1, 2, 5 and 10 minutes, and every 10 minutes after that. "Out of credit" (`insufficient_quota`) and rejected keys (401/403) are not retried within the request and are tried again every 15 minutes; saving a new `embedding_api_key` (or `omlx_api_key`) retries at once. One log line is written per failure with the time of the next try. **Settings → Embedding** shows the failure, the next attempt and what to do. Keyword search keeps working throughout; new chunks just wait for their vectors. The first failure of a quota or key problem raises a warning alert; a rate limit or outage raises one only after 30 minutes. An info alert notes when embedding resumes.

**Changing model.** When the configured model changes, the server starts embedding everything with the new one in the background while search keeps using the old one. **Settings → Embedding** shows the progress and an **Activate** button once it is complete. From the command line:

```sh
retrospecticus embedding list
retrospecticus embedding activate <slug>
```

The slug has the form `<provider>-<model>`, for example `openai-text-embedding-3-small` or `ollama-embeddinggemma-2` or `omlx-embeddinggemma-2-bf16`. `retrospecticus reembed --model <slug>` fills a model's vectors from the command line instead.

### Ranking

Search merges a keyword ranking (BM25) and a vector ranking with weighted reciprocal rank fusion. Keyword results count double by default (`search.keyword_weight` 2, `vector_weight` 1), so an exact phrase is not pushed down by a near-miss that merely sounds similar.

Chunks are one conversation turn, split when longer than `indexer.chunk_tokens` (400 by default). Changing it re-chunks every session, and only the chunks that changed are re-embedded. In testing, smaller chunks made vector search worse (paraphrase MRR 0.54 at 400 tokens, 0.33 at 100, 0.25 at 64), and larger ones gained nothing because most turns already fit. These figures came from a synthetic corpus of about 300 sessions with planted details.

## Alerts

Alerts go through notifier adapters. The `log` adapter is always on and writes to the server log. Turn on Discord and email in the setup wizard or under **Settings**, or in `config.json`:

```json
"notifiers": {
  "discord": {},
  "email": { "from": "<sender-address>", "to": ["<recipient-address>"] }
}
```

The Discord webhook URL and the SMTP URL (for example `smtps://user:password@smtp.example.com:465`) are the `discord_webhook_url` and `smtp_url` secrets. Breaking and warning alerts are sent at once. Info alerts are batched into a digest sent at `alerts.digest_hour`. **Send test alert** on the admin page, or `retrospecticus notify test`, sends a sample through every enabled adapter.

## Format drift and recovery

The raw archive is always complete, so a change in the Claude Code or Codex file format can only affect the derived index. When the parser meets a shape it does not understand, the line is quarantined, a drift event is recorded and an alert is sent. Before `shapes learn` has recorded the baseline, only these breaking changes alert. After it, a record type that gains a field it never had before, and a new harness version, are reported once each in the daily digest; a new mix of fields already seen for that record type is not reported.

Record families that never carry conversation, Claude Code's `system/*` records and Codex's `event_msg/*` records, are bookkeeping: a kind the parser has not seen before is skipped and reported as a new record type in the digest, not quarantined. Unknown top-level record types, records that fail validation and unknown content blocks stay breaking, because they can mean conversation is missing from search.

**Ignoring a bookkeeping type.** If a breaking event is for a record type you can see is bookkeeping (from its sample in **Format drift** on the admin page, or `drift show`), choose **Ignore this type**. It adds the type to `drift.ignore_types`, reparses the lines quarantined for it and acknowledges the event, with no release. **Stop ignoring** removes it again.

To recover from any other breaking change:

1. List open events and inspect one. `drift show` prints the scrubbed sample (string values replaced by their length) and a diff against the nearest known shape.

   ```sh
   retrospecticus drift list
   retrospecticus drift show <id>
   ```

2. Update the parser in `packages/server/src/parsers/` and add the scrubbed sample as a fixture.

3. Mark the shape as known:

   ```sh
   retrospecticus drift ack <id>
   ```

4. Re-run the parser over the affected lines, or over everything from a source since a date:

   ```sh
   retrospecticus reparse --quarantined
   retrospecticus reparse --source codex --since <date>
   ```

`drift list --all` includes events that are no longer open. `--source` takes `claude-code` or `codex`, and `--since` takes an ISO 8601 date or time.

## Health

```sh
retrospecticus doctor
```

`doctor` checks the config, the data directory, FTS5 and `sqlite-vec`, archive sizes against the database, the parse and embedding backlogs, open drift events, the last heartbeat per machine and the notifier config. It exits with code 1 on any failure.

Agents can call the `memory_status` tool for index freshness per machine, the embedding backlog and open drift alerts. `search_memory` also appends a warning line when open drift alerts may hide recent sessions.

## Data and backup

All state lives under one data directory (`data_dir`, default `/var/lib/retrospecticus`):

```
raw/<machine>/<source>/<relative path>[.gN]    original bytes, append-only
db/retrospecticus.sqlite                       everything derived
```

Only `raw/` must be backed up. It is plain append-only files and is safe to copy at any time. The database can be rebuilt from it, so a backup that copies it mid-write loses nothing permanent. Backups are the host's job; this tool only keeps the layout simple.

To restore, put `raw/` back and run:

```sh
retrospecticus reindex --from-raw
```

After a restore from `raw/` alone, reissue the tokens (`token create`) and relearn the shapes (`shapes learn`).

## Security notes

- The server is published on one private address only (`RETROSPECTICUS_BIND` in Docker, `listen_host` otherwise). Nothing is exposed publicly.
- Bearer tokens are per machine and purpose, with scopes `ingest` (append only), `search` (read only) and `admin`. Only SHA-256 hashes are stored.
- Enrollment is approval-based. Anyone on the private network can ask to enroll (at most 20 pending requests, each expiring after 10 minutes), but a token is issued only after an admin types the code shown on the new machine into the admin page. The collector receives it once; the server never stores it in plain text.
- The admin page uses an HttpOnly, SameSite=Strict session cookie (12 hours, in memory, so a restart signs you out) and requires a custom header on every change, which blocks cross-site requests. The cookie is not marked Secure because the server is reached over plain HTTP on a private network. Revoking the admin token ends its sessions.
- No endpoint serves the raw archive.
- Every search is logged in `query_log`.
- Client tokens live in files with mode 0600 or in environment variables, never in a repository.
- Secrets (the embedding API key, webhook and SMTP URLs, the GitHub token) live only in `secrets.json`, mode 600, beside the config and outside the data directory, so data backups never contain them. The admin page never sends a secret back to the browser.
- First-time setup is unlocked by a one-time code printed only in the server log, and closes for good once an admin token exists.
- Collector downloads and `install.sh` need no token: the executables hold nothing secret, and a machine still needs an admin's approval to get one. The server only passes on a download whose checksum matches the release's `SHA256SUMS`, and `install.sh` checks it again.
- The embedding provider receives only redacted chunk text and search queries.
- Secrets are redacted before text enters the search index. Recalled text is always returned inside a block that marks it as quoted history, not instructions.
- Session transcripts contain private code and secrets. Treat the data directory accordingly.

## Releases

Pushing a version tag publishes the collector executables:

```sh
git tag v0.1.0 && git push origin v0.1.0
```

`.github/workflows/release.yml` checks that the tag matches `VERSION` in `packages/shared/src/index.ts`, runs the type check and the tests, builds the four collectors and attaches them, the Linux server packages (x64 and arm64) and `SHA256SUMS` to a GitHub release, then publishes the server image for linux/amd64 and linux/arm64 to `ghcr.io/chris-gibson/retrospecticus` as `<version>`, `<major>.<minor>` and `latest`. The image's build stage cross-compiles and its final stage runs no commands, so both platforms build on an x64 runner without emulation. A server hands new machines the collector from the release matching its own `VERSION`, so bump `VERSION`, rebuild the server and tag together.

## Command reference

Every command prints its usage when given a wrong argument, and `retrospecticus` or `retrospecticus-collector help` alone lists the commands. In Docker, prefix server commands with `docker exec retrospecticus` (add `-i` for `secrets set`).

### Server: `retrospecticus [--config <path>] <command>`

The config path defaults to `$RETROSPECTICUS_CONFIG`, then `/etc/retrospecticus/config.json`.

| Command | What it does |
|---|---|
| `serve` | Runs the server in the foreground (the container's default command). |
| `health [--url <server-url>]` | Exits 0 when the running server answers `/healthz`; the container's health check. |
| `doctor` | Checks config, secrets, database, backlogs, drift, collectors and notifiers, and reports problems. |
| `token create --scope <ingest\|search\|admin> [--machine <m>] [--name <n>]` | Creates a token and prints it once. `ingest` needs `--machine`. |
| `token list` | Lists tokens (never their values). |
| `token revoke <id>` | Revokes a token. |
| `secrets list` | Shows which secrets are set. |
| `secrets set <name>` | Sets a secret from standard input: `embedding_api_key`, `omlx_api_key`, `discord_webhook_url`, `smtp_url`, `github_token`. |
| `secrets unset <name>` | Removes a secret. |
| `embedding list` | Lists embedding models with their vector counts and which one search uses. |
| `embedding activate <slug> [--force]` | Switches search to a model; refuses one with missing vectors unless forced. |
| `embedding drop <slug>` | Deletes a model's vectors. |
| `reembed --model <slug> [--dimensions <n>] [--batch-size <n>]` | Fills a model's vectors for every chunk while the active model keeps serving search. |
| `drift list [--all]` | Lists open format-drift events (`--all` includes closed ones). |
| `drift show <id>` | Shows an event's scrubbed sample and how it differs from known shapes. |
| `drift ack <id>` | Acknowledges an event. |
| `shapes learn` | Records the current corpus as the drift baseline; run once after the first history is indexed. |
| `reparse --quarantined` | Re-runs the parser over quarantined lines. |
| `reparse [--source <claude-code\|codex>] [--since <date>]` | Re-runs the parser over whole files. |
| `reindex --from-raw` | Rebuilds everything derived from the raw archive (the restore path). |
| `notify test` | Sends a sample alert through every enabled notifier. |
| `licenses` | Prints the licenses of the server and the third-party software it contains. |

### Collector: `retrospecticus-collector [command]`

The config defaults to `$RETROSPECTICUS_COLLECTOR_CONFIG`, then `~/.config/retrospecticus/collector.json`.

| Command | What it does |
|---|---|
| `run [--config <path>]` | Uploads transcripts until stopped (the default command; what the service runs). |
| `enroll --server <url> [--machine <name>] [--install \| --no-install] [--remote-update \| --no-remote-update] [--config <path>] [--force]` | Registers this machine; you approve it on the admin page. Offers to install the service, and asks whether the server may update this collector remotely. |
| `install [--config <path>]` | Installs and starts the background service (systemd user unit or launchd agent). |
| `update [--config <path>] [--force]` | Replaces the installed binary with the server's version (checksum verified) and restarts the service; no new token. Never downgrades without `--force`. |
| `remote-update on\|off [--config <path>]` | Lets the server's admin page upgrade this collector (default off), or stops it. Restarts the service if one is installed; otherwise restart the collector yourself. |
| `uninstall [--purge] [--config <path>]` | Removes the service; `--purge` also revokes this machine's token on the server and removes config, token, state, log, the installed binary and the emptied directories. |
| `status [--config <path>]` | Shows the config, service state, server reachability and the local status page. |
| `version` | Prints the version. |
| `licenses` | Prints the licenses of the collector and the third-party software it contains. |
| `help` | Lists the commands. |

## Development

```sh
bun install
bun test
bun run typecheck
bun scripts/build.ts            # dist/server (this platform) and dist/collectors (all four)
```

A server with `$RETROSPECTICUS_DOWNLOADS_DIR` pointing at a `dist/collectors` build hands out those collectors instead of fetching a release.

Test fixtures are regenerated only through `scripts/make-fixtures.ts`, which reads the live session directories read-only and writes scrubbed copies. Never commit an unscrubbed transcript.

- [docs/session-formats.md](docs/session-formats.md): what Claude Code and Codex write, and how the parsers treat it.

## License

MIT. See [LICENSE](LICENSE).

The release executables and the container image also contain third-party software, chiefly the Bun runtime (MIT), which statically links JavaScriptCore and tinycc under the LGPL. [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) lists it all with licenses, where to get the LGPL sources and how to rebuild with modified versions. The same text ships with every release, in the image at `/usr/share/doc/retrospecticus/`, and inside the executables: run `retrospecticus licenses` or `retrospecticus-collector licenses`. After changing dependencies, regenerate it with `bun scripts/third-party-notices.ts`; the release workflow fails if it is out of date.
