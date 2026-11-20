# Manual test: the collector on macOS

Exercises what the automated tests can only fake on Linux:
- the enroll prompts under the piped installer (the old `EINVAL: kqueue` failure, Ctrl-C and Ctrl-D);
- launchd install and restart;
- `update` and rerunning the installer;
- `uninstall --purge`.

You need two machines:
- **Linux box:** runs a throwaway server from a checkout of `main`.
- **Mac:** runs the collector; this is the machine under test.

The Mac uploads its real `~/.claude` and `~/.codex` sessions to the throwaway server. They stay in the test directory on the Linux box, and teardown deletes them.

Allow about 30 minutes.

## 1. Scaffold the Linux box

Pick an address the Mac can reach: the Linux box's LAN or Tailscale IP. Don't use `127.0.0.1` or `0.0.0.0`.

```sh
REPO=~/code/retrospecticus
RT=/tmp/retrospecticus-mac-test
ADDR=192.168.1.10          # this machine's LAN or Tailscale IP
PORT=7979                  # not 7878, so it never clashes with a real server

cd "$REPO" && git pull && bun install
mkdir -p "$RT/data" "$RT/config" && chmod 700 "$RT/config"
cat > "$RT/config/config.json" <<EOF
{ "data_dir": "$RT/data", "listen_host": "$ADDR", "listen_port": $PORT }
EOF

# Collectors at the current version (v1), built from this checkout.
bun scripts/build.ts --out "$RT/v1" --server none --collectors darwin-arm64,darwin-x64
```

Start the server and keep this terminal open:

```sh
RETROSPECTICUS_DOWNLOADS_DIR="$RT/v1/collectors" bun "$REPO/packages/cli/src/main.ts" --config "$RT/config/config.json" serve
```

Open the `First-time setup: open http://$ADDR:$PORT/admin/setup?code=…` link it prints. Then:
1. Save the admin token.
2. Choose **None** for embeddings.
3. Skip alerts and agents.
4. Stop at **Add your first machine**.

Leave the admin page open on the **Machines** tab.

## 2. Check the Mac before you start

```sh
SERVER=http://192.168.1.10:7979      # $ADDR:$PORT from above
curl -fsS "$SERVER/healthz"           # {"ok":true,"version":"…"}
ls ~/.local/bin/retrospecticus-collector ~/.config/retrospecticus \
   ~/Library/LaunchAgents/com.retrospecticus.collector.plist 2>&1
```

All three paths should be "No such file". If a collector is already installed, note where it points (`~/.local/bin/retrospecticus-collector status`). Then remove it with `uninstall --purge`, or test on another account.

## 3. Test cases on the Mac

Run every command in Terminal.app. That's where the bug showed up, because it hands the installer a real terminal. `C` below means `~/.local/bin/retrospecticus-collector`.

| # | Do | Expect |
|---|---|---|
| 1 | `curl -fsSL "$SERVER/install.sh" \| sh`, then **Ctrl-C** at `Machine name [...]:` | It returns to the shell at once, with no `EINVAL`/`kqueue` error. What you type afterwards echoes normally. `~/.config/retrospecticus` does not exist. |
| 2 | Run the installer again and press **Ctrl-D** at the machine-name prompt | `cancelled: no answer (end of input)`, then `Enrollment did not finish. To retry: …`. Nothing new appears on the Machines tab. |
| 3 | Run the installer again and type `mac-test` | It prints an approval code, and the Machines tab shows a pending request. Approve it, and the Mac prints `Approved. Machine mac-test is enrolled.` |
| 4 | At `Install as a background service…? [Y/n]` press **Ctrl-D** | It declines without failing: it prints how to install the service by hand and exits 0. `ls ~/Library/LaunchAgents/com.retrospecticus.collector.plist` gives "No such file". |
| 5 | `C install` | `launchctl print gui/$(id -u)/com.retrospecticus.collector \| grep -E 'state\|pid'` shows `state = running` and a pid. |
| 6 | `C status`, and `curl -s http://127.0.0.1:7879/status.json` | The server is reachable and the heartbeat is recent. The Machines tab shows `mac-test` with collector `0.1.x` and files uploading. |
| 7 | Note the pid from row 5, then run the installer again | `Updated; this machine was already enrolled with …`. No new approval request appears. `launchctl print …` shows a **new** pid: kickstart restarted the agent in place. |

## 4. Update to a newer server

On the Linux box, build a second version from a worktree with a bumped version number. Stop the v1 server (Ctrl-C), then start v2 against the same config and data:

```sh
git -C "$REPO" worktree add "$RT/v2-src" HEAD
sed -i -E 's/^export const VERSION = "[^"]+";/export const VERSION = "0.1.99-mactest";/' "$RT/v2-src/packages/shared/src/index.ts"
grep 'export const VERSION' "$RT/v2-src/packages/shared/src/index.ts"   # check it changed
(cd "$RT/v2-src" && bun install && bun scripts/build.ts --out "$RT/v2" --server none --collectors darwin-arm64,darwin-x64)

RETROSPECTICUS_DOWNLOADS_DIR="$RT/v2/collectors" bun "$RT/v2-src/packages/cli/src/main.ts" --config "$RT/config/config.json" serve
```

| # | Do | Expect |
|---|---|---|
| 8 | Reload the Machines tab | `mac-test` shows **outdated (0.1.x, server 0.1.99-mactest)** with the update commands. |
| 9 | On the Mac: `C update` | `Updating 0.1.x -> 0.1.99-mactest`, `Installed …`, `Restarted the service.` `C version` prints `0.1.99-mactest`, and the launchd pid changed. Within a heartbeat the outdated badge disappears. No `retrospecticus-collector.prev` or `.new` file is left in `~/.local/bin`. |
| 10 | `C update` again | `Already up to date (0.1.99-mactest).` |

## 5. Uninstall

| # | Do | Expect |
|---|---|---|
| 11 | `C uninstall --purge` | It prints `Revoked this machine's token on …`, then a `Removed …` line for the plist, config, token, state, binary, log, `~/.config/retrospecticus` and `~/.local/state/retrospecticus`. |
| 12 | Check that nothing is left | All of these give "No such file": `ls ~/.local/bin/retrospecticus-collector ~/.config/retrospecticus ~/.local/state/retrospecticus ~/Library/LaunchAgents/com.retrospecticus.collector.plist ~/Library/Logs/retrospecticus-collector.log`. `launchctl print gui/$(id -u)/com.retrospecticus.collector` reports the service is not found. |
| 13 | Reload the Machines tab | `mac-test` is marked **retired**. |

## 6. Tear down

On the Linux box, stop the server with Ctrl-C, then:

```sh
git -C "$REPO" worktree remove --force "$RT/v2-src"
rm -rf "$RT"          # the server's data, including the Mac's uploaded sessions
```

The Mac is already clean after row 12. If a case failed partway through, clean it up by hand:

```sh
launchctl bootout gui/$(id -u)/com.retrospecticus.collector 2>/dev/null
rm -f ~/Library/LaunchAgents/com.retrospecticus.collector.plist ~/Library/Logs/retrospecticus-collector.log \
      ~/.local/bin/retrospecticus-collector ~/.local/bin/retrospecticus-collector.prev ~/.local/bin/retrospecticus-collector.new
rm -rf ~/.config/retrospecticus ~/.local/state/retrospecticus
```

## Recording results

For each row, record pass or fail. For a failure, copy the terminal output and the last lines of `~/Library/Logs/retrospecticus-collector.log`, then add them to the matching issue: #4 for the prompts, or the lifecycle work for rows 7–13.
