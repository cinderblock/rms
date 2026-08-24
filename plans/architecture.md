# Remote Management Daemon — Architecture & Bootstrap Plan

> Living document. Read this first in any session on this project. Update it in the
> same turn as any discovery that contradicts it.

## Goal

A thin client, easily installed on Cameron's devices, that dials home to a
self-hosted control server and executes commands securely. Plus:

- A control server binary that serves a management UI (stats + basic controls for
  connected hosts), authenticated with **passkeys only**, single user.
- Libraries for talking to that backend, usable by both humans and AI agents.
- **The first real feature is client self-update**, proven end-to-end through
  GitHub CI. Everything else is built on top of a client that can already fix
  itself in the field.

## Environment / context

| Thing | Value |
|---|---|
| Repo root (dev) | `C:\Users\camer\git\vibed-out\remote-mgmt-daemon` |
| Primary branch | `master` (system-level `init.defaultBranch`, deliberate) |
| Dev machine | Windows 11 Pro N 26200 |
| Toolchains present | bun 1.3.0, node 24.18.0, rustc/cargo 1.97.1, gh 2.83.2, pnpm 11.10.0 |
| JS package manager | **Bun** + `bun.lock` (global standing rule) |
| Release path | GitHub Actions only. **Never publish/release from a CLI.** |

## Decisions already made (don't re-ask)

These were answered directly by Cameron on 2026-08-24.

1. **Platforms.** Windows first. Linux second. macOS eventually, but *without* a
   $99 Apple Developer ID — self-signed / developer-mode install is acceptable
   for personal use. So: no notarization in the pipeline; macOS builds are
   ad-hoc-signed and the user right-click-opens them.
2. **Repo is public; updates come from GitHub Releases.** Tauri's updater points
   at a public `latest.json` published by CI. Signature-verified with a Tauri
   updater keypair. The control server is *not* required for updates to work —
   important, because the control server is exactly the thing likely to be broken
   when an update is most needed.
3. **Transport is a client-dialed WebSocket over TLS.** Outbound only, no inbound
   firewall holes, instant push, and connection liveness doubles as the
   online/offline signal.
4. **Split architecture: privileged service + user-session tray app.** The tray is
   not merely a UI — it is *also the user-session execution agent*. Cameron
   explicitly wants the ability to reach into the interactive desktop session on
   occasion (show a notification, launch a GUI app, read the clipboard, take a
   screenshot). See "Session boundary" below; this is the single most important
   structural decision in the project.
5. **Two independent update triggers** (by design, as a mutual backup): a tray
   menu item for a manual check, and a server-pushed `update.check` command. Plus
   the ambient timer (default 1h).

## Architecture

### Three-process model on a managed host

```
              (WSS, client-dialed, Ed25519 device auth)
   control server  <────────────────────────────────────┐
                                                        │
  ┌─────────────────────────────────────────────────────┴──────┐
  │ HOST                                                       │
  │                                                            │
  │  ┌──────────────────────┐        ┌──────────────────────┐  │
  │  │ agentd (service)     │  local │ tray (Tauri)         │  │
  │  │ - SYSTEM / root      │◄──IPC─►│ - runs as the user   │  │
  │  │ - holds the WS conn  │        │ - tray icon + menu   │  │
  │  │ - owns device key    │        │ - user-session exec  │  │
  │  │ - runs the updater   │        │ - update check UI    │  │
  │  │ - privileged exec    │        │ - shows status       │  │
  │  └──────────────────────┘        └──────────────────────┘  │
  └────────────────────────────────────────────────────────────┘
```

`agentd` is the only thing that talks to the control server. The tray never holds
a device credential and never dials out. That keeps the trust boundary in one
place and means a compromised user session can't impersonate the host.

### Session boundary (Windows session 0 isolation)

A Windows service runs in session 0 and **cannot** draw UI or touch the
interactive desktop. The classic workaround (`WTSQueryUserToken` +
`CreateProcessAsUser`) is doable but is a well-known privilege-escalation
foot-gun and is fragile across fast-user-switching and RDP.

**Chosen approach:** don't cross the boundary from the service at all. Instead the
tray app — already running *inside* the interactive session as the user —
connects to the service and registers itself as the executor for
`session`-scoped commands. The service routes those commands to it and relays
the result. If no tray is connected (logged out), `session`-scoped commands fail
fast with `no_interactive_session` rather than hanging.

This gives the "interact with the user session" capability with no token
impersonation, no session-0 UI hacks, and a natural failure mode.

**IPC:** Windows named pipe (`\\.\pipe\rmd-agent`) with an explicit DACL granting
only the logged-on user + SYSTEM; Unix domain socket at `$XDG_RUNTIME_DIR/rmd-agent.sock`
mode 0600 elsewhere. Length-prefixed JSON frames, same envelope shape as the
WS protocol so one codec serves both.

> ⚠️ The tray is a *lower*-privilege process asking a *higher*-privilege one for
> work. Commands must be authorized by the **service**, never by the tray, and the
> service must treat everything arriving over IPC as untrusted input. The IPC
> surface is deliberately tiny: `hello`, `session_result`, `check_update`,
> `get_status`, `quit`.

### Repo layout

```
remote-mgmt-daemon/
├─ Cargo.toml                  # Rust workspace
├─ package.json                # Bun workspace root
├─ bun.lock
├─ plans/
├─ .github/workflows/
│   ├─ ci.yml                  # lint + typecheck + test + build on PR
│   └─ release.yml             # tag → build matrix → signed GH Release
├─ crates/
│   ├─ agent-core/             # transport, config, command exec, update logic
│   ├─ proto/                  # wire types (GENERATED from packages/protocol)
│   └─ ipc/                    # service <-> tray local channel
├─ apps/
│   ├─ agentd/                 # privileged service host  (Rust bin)
│   ├─ tray/                   # Tauri tray app + session executor
│   └─ server/                 # Bun + Hono control server + management UI
└─ packages/
    ├─ protocol/               # zod schemas — SINGLE SOURCE OF TRUTH for the wire
    ├─ client-sdk/             # typed client for humans & agents
    └─ ui/                     # React management UI (built into the server binary)
```

### Wire protocol: one source of truth

Schemas are authored **once** in `packages/protocol` with zod. CI then:

1. emits JSON Schema from the zod definitions,
2. runs [`typify`] to generate `crates/proto/src/generated.rs`,
3. fails the build if the generated file differs from what's committed.

So the TS server and SDK use the zod types directly; Rust gets serde structs that
cannot silently drift. Committing the generated file keeps `cargo build` working
without a Bun step in the loop.

### Device identity & enrollment

- On first run `agentd` generates an **Ed25519 keypair**. The private key is
  stored via the OS keystore (`keyring` crate → DPAPI/Keychain/Secret Service),
  falling back to a 0600 file with a clear warning.
- First run asks for the **control server base URL** (tray dialog, or
  `--server` / `RMD_SERVER` for headless installs).
- The client posts an enrollment request `{pubkey, hostname, os, arch}` plus a
  short-lived **enrollment code** generated in the management UI. No code, no
  enrollment — never trust-on-first-use for host admission.
- Thereafter, WS auth is challenge–response: server sends a nonce, client signs
  it. No bearer token to leak, and revocation is just deleting the pubkey.

### Server auth (single user, passkeys only)

- **First-run claim token.** The server prints a one-time setup token to stdout on
  first boot. `/setup?token=…` is the *only* way to register the initial passkey.
  Plain "first visitor wins" is a race that the public internet will win, so it is
  not used.
- Passkeys via `@simplewebauthn/server`. Multiple credentials, one user.
  `userVerification: required`. RP ID pinned to the deployed hostname.
- **Agent access tokens:** named, scoped, expiring, shown exactly once, stored as
  a hash. Sent as `Authorization: Bearer`. Listed and revocable in the UI. These
  are what an AI agent or a script uses; they never get passkey-equivalent power
  (no token management, no user enrollment).

### Update flow (the first working feature)

```
git tag v0.1.0 ──▶ release.yml ──▶ matrix build (win/linux/mac)
                                 ──▶ sign each artifact with TAURI_SIGNING_PRIVATE_KEY
                                 ──▶ publish GH Release + latest.json
                                                    │
   agentd/tray checks latest.json ◄─────────────────┘
        (hourly | tray menu | server push)
                │
                ├─ signature verified against the public key baked into the binary
                ├─ download, stage, swap
                └─ restart
```

Three triggers, one code path. The server-push trigger exists purely so a broken
timer or a broken tray still leaves a way in — and the GH-hosted `latest.json`
exists so a broken *server* still leaves a way in.

## Phases

Ordered so that the self-updater lands before there's much to update.

- [x] **Phase 0 — Repo skeleton.** Cargo + Bun workspaces, CI that lints/builds,
      `.gitignore`, README, licence. Nothing functional. *(commit `6c108f2`)*
- [ ] **Phase 1 — Self-update, proven.** Single Tauri tray app, no server
      involvement. Tray menu: status / check for updates / quit. Hourly timer.
      `release.yml` produces a signed release; the app updates itself from v0.1.0
      to v0.1.1 on a real machine. **This phase is done when a manual tag causes
      an already-installed client to upgrade unattended.**
      - [x] Tray icon, menu, hidden status window, autostart-at-login
      - [x] Update check with a re-entrancy gate; timer + menu triggers
      - [x] `release.yml` with signing, draft-then-publish, version guard
      - [ ] **Blocked:** GitHub repo doesn't exist yet, so nothing has been
            pushed and the release workflow has never run. Needs the repo
            created, the signing secrets added, and one real tag→upgrade test.
- [ ] **Phase 2 — Control server skeleton.** Bun + Hono, SQLite, passkey setup
      flow with claim token, management UI shell, `/api/health`. No hosts yet.
- [ ] **Phase 3 — Enrollment + WS transport.** Device keypair, enrollment codes,
      challenge–response, host list with live online/offline. First command:
      `ping`. Second: `update.check` (the server-side update trigger).
- [ ] **Phase 4 — Service split.** `agentd` as a Windows service / systemd unit,
      tray demoted to IPC client + session executor. Solve service self-update
      (stop → swap → start via a detached helper).
- [ ] **Phase 5 — Real commands + libs.** Command catalogue, `client-sdk`, agent
      tokens, stats panel.

## Findings / gotchas

- **Updater signing key lives at `~/.rmd-updater/updater.key`** (outside the repo,
  generated 2026-08-24, no passphrase). Its public half is committed in
  `tauri.conf.json`. If that private key is lost, **no existing client can ever
  be updated again** — they will reject artifacts signed by any other key. Back
  it up off-machine. It must be added to GitHub as `TAURI_SIGNING_PRIVATE_KEY`,
  with `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` set to the empty string.
- **`panic = "abort"` is wrong for Tauri.** Tauri unwinds across the webview FFI
  boundary; aborting there converts recoverable errors into silent crashes. The
  workspace release profile deliberately omits it. (Also: `[profile.*]` in a
  workspace *member* is ignored by Cargo — it only reads the workspace root.)
- **`icon_as_template(true)` is wrong for a full-colour icon.** macOS renders
  template icons as a monochrome mask, so the app icon becomes a solid blob in
  the menu bar. Currently `false`; needs a dedicated monochrome glyph before
  macOS is a real target.
- **`gh api repos/…/releases/tags/<tag>` returns 404 for *draft* releases.**
  `release.yml` falls back to listing all releases and filtering by tag. Don't
  "simplify" that back to the single call.
- **Unverified: `tauri-action` + Bun workspaces.** `apps/tray` has a
  `package.json` but no lockfile of its own (Bun hoists to the root), so
  tauri-action will probably fall back to `npm install` inside `apps/tray`.
  Expected to work, just slower. Confirm on the first real release run and fix
  here if not.

## Things not to do

- **Don't put the device credential in the tray app.** It runs in a user session
  that can be trivially inspected; the whole point of the split is that the tray
  is not trusted.
- **Don't use `WTSQueryUserToken` + `CreateProcessAsUser`** to reach the desktop.
  See "Session boundary" — we route through the tray instead.
- **Don't make the control server a dependency of the update path.** That
  circularity is what bricks fleets.
- **Don't ship trust-on-first-use** for either host enrollment or the admin
  passkey. Both get an explicit out-of-band code.
- **Don't hand-write the wire types twice.** Generate the Rust side.
- **Don't release from a CLI.** Tag, and let CI do it.

## Open questions for the user

1. **Where will the control server actually be deployed?** The passkey RP ID has
   to be a stable hostname decided before Phase 2 lands, and it's baked into
   client config. My recommendation: a container on `steamboat` behind the
   existing Caddy, on a subdomain — but that's an infra change, so it needs
   explicit authorization and should go through the `ops` repo.
2. **Repo name.** Directory is `remote-mgmt-daemon`; the public GitHub repo can be
   anything. Since the repo will be public, worth picking a name you like now
   rather than renaming later.
3. **Scope of "commands".** Phase 5 needs a catalogue. Arbitrary shell execution
   is the most useful and the most dangerous; a fixed allowlist of verbs is safer
   but needs a release to extend. Recommendation: fixed verbs first, with an
   explicitly-flagged `shell` verb that's off by default per-host.

## Progress log

- **2026-08-24** — Brief captured, four architecture decisions locked (see
  above), toolchain verified on the dev box, this plan written.
- **2026-08-24** — Phase 0 + most of phase 1 built and committed (`6c108f2`).
  `cargo fmt`, `cargo clippy -D warnings` and a debug build all pass locally on
  Windows. Updater keypair generated. Hit and fixed one real compile error:
  `TrayIconBuilder`'s runtime parameter defaults to `Wry`, so a `build<R: Runtime>`
  signature fails to unify at `.build(app)` — the tray module is deliberately
  non-generic now.
  **Not yet verified:** the app has never been *run* (launching it would enable
  autostart on this machine, which is Cameron's call), and CI has never
  executed because there is no GitHub remote yet.
