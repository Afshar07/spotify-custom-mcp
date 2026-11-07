# Spotify Curator Plugin Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Package the existing MCP with skills, default contextual covers, optional local extended-history import, and a one-click upgrade that reuses the existing sign-in.

**Architecture:** Keep the stdio server and per-user credential store. Install a local plugin referencing the existing executable; merge a personal marketplace and enable the plugin before disabling the old matching MCP entry. Index only music history fields locally. The assistant generates art; the server validates and uploads JPEGs without an image-provider key.

**Tech Stack:** Existing TypeScript, Node, MCP SDK, Zod, Vitest, TOML patcher; no hosted service.

**Spec:** Approved design in this chat on 2026-11-07, recorded below.

## Global Constraints

- Reuse existing credentials; never put secrets in plugin files or marketplace metadata.
- Existing MCP contracts remain compatible. History import is optional and local.
- New-playlist workflow generates contextual creative cover art by default, with no user's name. Explicit opt-out is supported. Image generation belongs to the host assistant; missing image tools are reported honestly.
- Cover permission upgrade uses Spotify browser consent; existing music features remain usable without it.
- Migration backs up configuration, preserves unrelated entries, avoids duplicate active servers, and supports retry/rollback. Do not publish or change live settings during development.

## Review Focus

- Failed handshake or conflicting local files: leave the existing connection enabled.
- Legacy env/cwd installs: preserve their connection without exporting secrets to the plugin.
- Overlapping or malformed exports: deduplicate exact events, preserve real repeat plays, fail without losing the prior index.
- Alternate editions: history checks use URI and normalized artist/title, with an explicit cutoff.
- Bad/oversized images or missing cover scope: no upload; retain the created playlist and explain the incomplete cover step.

## Tasks

- [x] 1. Add portable and Codex-compatible manifests plus curation, management, podcast and onboarding skills under `plugins/spotify-curator/`. Add the resource-copy build step and installation documentation.
- [x] 2. Add a local `HistoryStore`: bounded JSON folder import, compact persistent events, atomic replacement, status/clear/profile/candidate checks. Expose query tools and setup import controls. Test duplicate events, invalid files, normalization, cutoff and no-history behavior before implementation.
- [x] 3. Add JPEG validation, upload transport, scope and MCP tool. Return a default pending-cover instruction after playlist creation. Test payload/content type, invalid data, dry run and missing scope before implementation.
- [x] 4. Add `PluginInstaller` and setup/CLI upgrade entry points. Reuse the secure store, retain legacy settings through a private launcher, verify before switching, merge marketplace/config with backups, and provide rollback. Test in temporary homes and mocked handshakes before implementation.
- [x] 5. Update routed project docs, validate skills, run typechecks, tests, build, bundled executable tests, and review the diff. Report separately any desktop UI acceptance that cannot be verified.

## Execution notes

User authorized implementation with “Good. go on.” Work in the existing clean checkout: sandbox prevented creating a Git branch; no commits or live migration are performed. All migration tests use temporary homes and fake Spotify.

Review: independent review findings fixed and covered (inherited env_vars, stale locks, plugin cleanup, malformed JPEG structure, plugin-aware repair). Setup browser flow verified with a disposable profile and mocked handshake. Full JPEG entropy decoding is intentionally left to Spotify; no image library dependency was added after registry access failed. Skill-creator validator could not run without PyYAML; equivalent frontmatter, naming, JSON and reference-link checks passed. Final acceptance still requires real desktop plugin cache loading after restart and Spotify cover-consent/upload.

Final verification: both TypeScript checks and compiled build passed; Node SEA standalone build passed in build-plugin; 324 tests across 24 suites passed against that executable, including real env/env_vars migration, DPAPI sidecar, no-Node PATH startup and cleanup. git diff --check passed. Portable ZIP validated (4 skills, 32 MCP tools). No live user migration, credential consent, push, release or desktop restart performed. Inno Setup compiler unavailable locally; installer source updated, portable package built instead.
