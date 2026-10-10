# ChatGPT Desktop integration: feasibility findings

**Status: UNVERIFIED. Not implemented as automatic setup.**

## What was and was not established

| Question | Result |
| --- | --- |
| Does ChatGPT Desktop accept a local stdio MCP server? | **Unverified.** Search summaries of third-party pages say the desktop app has an "MCP servers" settings page with STDIO and Streamable HTTP options, and that Codex / ChatGPT Work modes run locally. Other sources say standard Chat mode and Developer Mode connectors are remote-HTTPS-only. These disagree and none is OpenAI's own page. |
| Plugin registration / packaging format | **Not found.** No official manifest or install path was found; none was invented. |
| Installation requirements, account/plan/version restrictions | **Unknown.** |
| Write-capable tool support, approval prompts | **Unknown.** |
| Tool discovery / invocation / process lifecycle | **Not tested.** No Windows ChatGPT Desktop was available (this build ran in a Linux container) and `learn.chatgpt.com` was unreachable (network policy). |

No proof-of-concept read-only tool was run against ChatGPT Desktop, so none of the verification checklist (registration, discovery, invocation, lifecycle, approvals) could be completed.

## What the product does instead

- The ChatGPT adapter (`src/clients/chatgpt-adapter.ts`) is **detect-nothing / write-nothing**: it never edits ChatGPT files, never calls private APIs, and never exposes a public HTTP endpoint.
- The wizard shows "Manual setup only (not verified)" and, when selected, lists manual steps (add a STDIO server pointing at `spotify-curator.exe mcp`). Those steps are explicitly labelled unverified.
- Diagnostics report ChatGPT as **skipped**, never as passing.
- OpenCode is unaffected.

## To close this out (needs a human with Windows + ChatGPT Desktop)

1. Read OpenAI's current documentation for ChatGPT Desktop MCP servers (settings location, plans, Windows support).
2. On a Windows 11 machine with a supported plan, add `spotify-curator.exe mcp` as a STDIO server by hand.
3. Confirm: tool discovery (28 tools), a read-only call (`get_playlist_summary` or search), process start/stop, and whether write tools (`add_playlist_items`, ...) are allowed and prompt for approval.
4. If it works and OpenAI documents a config file or CLI for adding servers, implement `install()` with that documented mechanism only; otherwise keep the manual path. Update this file and the status to Supported/Unsupported accordingly.
