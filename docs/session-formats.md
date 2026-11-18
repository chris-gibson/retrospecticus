# Session formats

What Claude Code and Codex actually write, and how the parsers treat it. Observed in November 2026 on Claude Code 2.1.258 to 2.1.327 and Codex 0.153.4 to 0.169.0. Neither format is documented or stable; drift detection exists because these notes will go out of date.

## Claude Code

Files: `~/.claude/projects/<project>/<session-id>.jsonl`, with subagent transcripts beside them.

- **Record types beyond `user` and `assistant`:** `agent-name`, `ai-title`, `api-request-shape`, `attachment`, `bridge-session`, `continued-in`, `cost-state`, `custom-title`, `frame-link`, `permission-mode`, `pr-link`, `relocated`, `system`, `tools-used`. `system` records are bookkeeping: a subtype the parser has not seen before, such as `stop_hook_summary` (from 2.1.327), is ignored and reported as additive drift rather than quarantined. Metadata records update the session (its title) and are otherwise ignored; every line stays in the raw archive.
- **Titles:** `custom-title` is set by the user and outranks `ai-title`.
- **Queued prompts:** `attachment` records of type `queued_command` hold prompts the user typed while the agent was busy. They are conversation and are indexed as user text.
- **`tool_addition` blocks** occur only inside `api-request-blob`, never in `user` or `assistant` records.
- **Ordering:** records form a tree through `parentUuid`, and a session can branch. File order is used as turn order; `parentUuid` is stored so threads can be rebuilt.
- **Subagents** get the session id `<parent-session-id>:<agentId>` with `parent_session_id` set.

## Codex

Files: `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`.

- **`response_item` is canonical.** The display copy of each turn is `event_msg/item_completed` (item types `UserMessage`, `AgentMessage`, `CommandExecution`, ...), so every `event_msg` is ignored to avoid counting turns twice, including kinds not seen before, which are reported as additive drift. `event_msg/user_message` and `agent_message` appear only in guardian sessions.
- **Guardian sessions** (`session_meta.payload.source.subagent.other == "guardian"`, `thread_source == "guardian_review"`) are about half of all files. They re-quote the parent transcript on every review and hold most Codex user text by volume. They are archived but not indexed: the session row has `kind = 'guardian'` and a parent link, every other line is ignored, and they are left out of yield monitoring.
- **User messages mix typed text with injected context.** `input_text` blocks starting with `<environment_context>`, `<codex_internal_context>`, `<turn_aborted>`, `<user_shell_command>` or `<image>` are harness context, and `role = "developer"` messages are instructions. Neither is indexed as user text.
- **Reasoning is encrypted** (`encrypted_content`) in almost every record. A reasoning message is produced only when `summary` has text.
- **A file can hold more than one `session_meta`.** Forked and spawned threads copy the parent's meta and history into the new file. The first `session_meta` defines the session. Copied history is skipped from `subagent_history_start_ordinal` onward, and anything left is collapsed at search time by `chunks.text_hash`.
- **No title in the file.** The title is the first 80 characters of the first user message.
- **Other record types seen:** `inter_agent_communication_metadata`; `response_item` payloads `additional_tools`, `agent_message`, `compaction`, `configuration_update`, `custom_tool_call`, `custom_tool_call_output`, `function_call`, `function_call_output`; `event_msg` types `item_completed`, `turn_aborted`, `thread_goal_updated`.

## Both

- **Lines can be several megabytes** (a Codex `compacted` record averages 2 MB). Uploads are capped at 8 MiB per request and so split at arbitrary byte positions; the collector never sends past a file's last newline, and the indexer never reads past the last newline of the archived file.
- **Session ids** are the harnesses' own and are assumed unique across machines.
- **Rewritten files:** when a file shrinks or is replaced it becomes a new generation. Every generation's raw bytes are kept, and only the newest is indexed.
- **Drift noise:** on a real archive, learning shapes from half the files and indexing the rest raised about 118 informational events, mostly new key names within depth 3. They go only to the daily digest. If that becomes too busy, the levers are the extended discriminator and the fingerprint depth.
