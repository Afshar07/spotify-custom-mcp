# Windows distribution

## Install (end users)

1. Download `SpotifyCurator-Setup-<version>.exe` from the project's release/CI artifact and run it. It installs per user to `%LOCALAPPDATA%\Programs\SpotifyCurator`; no administrator rights are needed.
2. Spotify Curator Setup opens in your browser (also in Start menu → *Spotify Curator Setup*).
3. Create a free Spotify developer app (the wizard explains how), add `http://127.0.0.1:8888/callback` as its Redirect URI, add your Spotify account under *User management*, and paste the **Client ID** (no Client Secret is needed or stored).
4. Choose **Connect Spotify**, approve in the browser, then choose **OpenCode** and **Set up selected apps**. Success is shown only after the program starts and lists its tools.
5. Open OpenCode and ask: "Show me my Spotify playlists."

Upgrading: run a newer installer over the old one. Credentials and settings live in `%LOCALAPPDATA%\SpotifyCurator`, outside the install folder, so they are preserved. Uninstall asks whether to also remove the saved Spotify sign-in and the OpenCode entry (`/REMOVEDATA=1` for silent uninstalls).

## Spotify restrictions that still apply

- Development Mode (per Spotify's Feb 2026 changes, from search summaries of Spotify's blog and migration guide): the app **owner needs Premium**, one Development Mode Client ID per developer, **up to 5 authorized users** per Client ID, reduced endpoint set. PKCE does not lift any of this. Friends other than the app owner must be added under *User management*; a 403 on connect means the account is not on that list.
- "Pre-authorized user" mode = a Client ID whose app already lists the user; "bring your own app" = the wizard walkthrough. Never share a Client Secret.

## Architecture decisions

- **Packaging:** Node.js Single Executable Application. `esbuild` bundles `src/cli.ts` to one CJS file, which is injected into a copy of `node.exe` (`scripts/build-exe.mjs`). One `spotify-curator.exe` serves both roles: `spotify-curator.exe mcp` (stdio MCP, never opens the wizard) and `spotify-curator.exe setup` (wizard). Rejected: bundling `node.exe` + loose JS (many files, path/working-directory fragility); `pkg`/`bun compile` (extra toolchains, MCP SDK compatibility untested). Tradeoff: ~85 MB installed. Tested on Linux with an empty `PATH` (`tests/runtime`), and by CI on Windows.
- **Setup UI:** a loopback-only local web wizard served by the same executable, opened in the default browser, instead of Tauri + Vue. Reason: it needs no Rust/WebView toolchain, is fully testable (headless Chromium) and shares one TypeScript codebase with the auth service. Protections: per-run secret cookie, Host/Origin checks, strict CSP. A Tauri shell can later wrap the same local API.
- **Credentials:** refresh token encrypted with Windows DPAPI (`CurrentUser`) via the built-in Windows PowerShell and stored in `%LOCALAPPDATA%\SpotifyCurator\credentials.bin`. Only non-secret data (Client ID, port) is in `settings.json`; nothing secret goes in OpenCode config. No background service: the MCP process reads the store itself and persists refresh-token rotation.
- **Signing:** the installer and exe are **unsigned**, so Windows SmartScreen will warn ("Windows protected your PC" → *More info* → *Run anyway*) until a code-signing certificate (OV/EV or Azure Trusted Signing) is added. Add a `signtool` step after `build:exe` and after `iscc` and update this file. Always publish `SHA256SUMS.txt`.

## Release checklist

- [ ] Bump `version` in `package.json` **and** `src/version.ts` (a test enforces they match).
- [ ] `npm run typecheck && npm run typecheck:tests && npm test` green.
- [ ] CI `Windows installer` workflow green, including the real-exe runtime tests and silent install/upgrade/uninstall smoke test.
- [ ] Manual acceptance on a clean Windows 11 VM (below).
- [ ] Download the CI artifact, confirm `SHA256SUMS.txt`, scan for secrets (none should be present: only the exe is packaged).
- [ ] Sign installer and exe (when a certificate exists).
- [ ] Create the GitHub release **manually, with owner approval**; CI never publishes.

## Manual acceptance (clean Windows 11, no Node/Git) — status: NOT YET RUN

- [ ] **A OpenCode:** install → connect → select OpenCode → open OpenCode → tools listed → list playlists → `generate_playlist` with `dryRun: true` creates nothing.
- [ ] **B ChatGPT Desktop:** only via an officially documented mechanism; see `docs/chatgpt-desktop.md` (currently unverified).
- [ ] **C Repair:** edit/delete the `spotify-curator` entry in `~/.config/opencode/opencode.json(c)` → open Setup → Test connection shows the problem → Repair → Test passes.
- [ ] **D Upgrade:** install N-1, connect, install N → still connected, OpenCode entry intact.
- [ ] Confirm no console window flashes when OpenCode starts the MCP, and that `~/.config/opencode` is the file OpenCode actually reads on Windows (see `.ai/opencode-integration.md`).
