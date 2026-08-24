# RMS (Remote Management System) — Architecture & Bootstrap Plan

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
| GitHub repo | `cinderblock/rms` — public (required for unauthenticated updater fetches) |
| Repo root (dev) | `C:\Users\camer\git\vibed-out\remote-mgmt-daemon` — the *directory* still has the old name; the project is `rms` |
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
6. **Enrollment uses a shared, reusable passphrase — not per-device codes.**
   Cameron wants to walk up to a machine, install, and register it on the spot
   without first visiting the management UI. The passphrase buys a permanent
   keypair; from then on the phrase is irrelevant to that device. Guardrails in
   "The enrollment passphrase" below. *(This supersedes the earlier per-device
   one-time-code design.)*
7. **The admin UI setup token stays as-is** — one-time, printed to stdout on
   first boot. Enrollment and admin login are separate problems: the first is
   frequent and needs to be frictionless, the second happens once and guards
   everything.

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

**IPC:** Windows named pipe (`\\.\pipe\rms-agent`) with an explicit DACL granting
only the logged-on user + SYSTEM; Unix domain socket at `$XDG_RUNTIME_DIR/rms-agent.sock`
mode 0600 elsewhere. Length-prefixed JSON frames, same envelope shape as the
WS protocol so one codec serves both.

> ⚠️ The tray is a *lower*-privilege process asking a *higher*-privilege one for
> work. Commands must be authorized by the **service**, never by the tray, and the
> service must treat everything arriving over IPC as untrusted input. The IPC
> surface is deliberately tiny: `hello`, `session_result`, `check_update`,
> `get_status`, `quit`.

### Repo layout

```
rms/
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

The design goal is: **walk up to a machine, install, type a passphrase, done.**
No detour to the management UI to mint a per-device code first.

- On first run the agent generates an **Ed25519 keypair**. The private key is
  stored via the OS keystore (`keyring` crate → DPAPI/Keychain/Secret Service),
  falling back to a 0600 file with a clear warning. **The server never sees it.**
- First run asks for the **control server base URL** and the **enrollment
  passphrase** (tray dialog, or `--server` / `RMS_SERVER` and
  `RMS_ENROLL_PASSPHRASE` for headless installs).
- The client `POST`s an enrollment request carrying its public key, the
  passphrase, and a self-described identity block (below). The server verifies
  the passphrase and records the public key as a permanent credential.
- Thereafter, WS auth is challenge–response: server sends a nonce, client signs
  it. No bearer token in flight to leak, and revocation is just deleting the
  public key.

#### The enrollment passphrase

One long-lived shared secret, set by the admin, reusable across machines. That
is a deliberate trade of some security for a lot of convenience, and it is only
defensible because of the guardrails below — none of which add friction at
install time:

- Stored **argon2id-hashed**, compared in constant time. Never logged.
- Generated by default as a 6-word diceware phrase (~77 bits) so the default is
  strong; the admin can set their own, with a floor on entropy.
- **Rate limited hard**: per-IP exponential backoff, plus a global failure
  counter that suspends enrollment entirely and raises an alert. A shared secret
  with no rate limit is a shared secret that gets brute-forced.
- **Enrollment can be toggled off** in the UI, and optionally auto-closes after a
  set window. Default is open, because the whole point is walking up to a machine.
- Every enrollment — success or failure — is logged with the server-observed IP,
  and every new device shows as **unacknowledged** in the UI until dismissed.
- The passphrase authorizes *joining the fleet*, nothing else. It never grants
  command execution, and it is not accepted anywhere except `POST /api/enroll`.

> Accept the residual risk knowingly: anyone holding the passphrase can add a
> host. That host can *receive* commands, not issue them — so the blast radius is
> "an attacker gets a machine listed in my dashboard", not "an attacker runs
> code on my machines". Rotating the passphrase does not disturb already-enrolled
> devices, because their credential is the keypair, not the phrase.

#### Identity block sent at registration

Client-asserted, therefore **informational only** — used to recognise machines in
the UI and to spot re-enrollments. Never used for authorization. The public key
is the identity; everything here is a label.

| Field | Windows | Linux | macOS |
|---|---|---|---|
| `hostname` | `GetComputerNameEx` | `gethostname` | `gethostname` |
| `machine_id` | `HKLM\SOFTWARE\Microsoft\Cryptography\MachineGuid` | `/etc/machine-id` | IOKit `IOPlatformUUID` |
| `os` / `os_version` | `windows` / build | `linux` / distro + kernel | `macos` / version |
| `arch` | `x86_64` \| `aarch64` | ″ | ″ |
| `user` | account the agent runs as | ″ | ″ |
| `agent_version` | crate version | ″ | ″ |
| `boot_id` | *(omitted)* | `/proc/sys/kernel/random/boot_id` | *(omitted)* |

**Re-enrollment is never automatic.** If an incoming `machine_id` matches an
existing device, the server still creates a *new* record and flags it as a
probable re-enrollment of the old one, for the admin to merge or delete.
Auto-replacing on `machine_id` match would let anyone with the passphrase
silently take over an existing device's record — that is the whole attack, and
it costs one click to avoid.

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
      flow with claim token, management UI shell, `/api/health`.
      - [x] Hono app, SQLite with an append-only migration runner, `/api/health`
      - [x] First-boot bootstrap: generates and prints the enrollment passphrase
            and a one-time admin setup token, both stored argon2id-hashed
      - [ ] `/setup` passkey registration consuming that token
      - [ ] Management UI shell
- [ ] **Phase 3 — Enrollment + WS transport.** Device keypair, passphrase
      enrollment, challenge–response, host list with live online/offline. First
      command: `ping`. Second: `update.check` (the server-side update trigger).
      - [x] Wire schemas for enrollment + auth in `packages/protocol`, with tests
      - [x] `POST /api/enroll` with argon2id verification, per-IP and global rate
            limiting, idempotent retries, and re-enrollment flagging
      - [x] Rust side: `crates/agent-core` — identity collection, Ed25519
            keypair in the OS keystore, enrollment client. Verified against the
            real server: a Rust client enrolled into the Bun server, and the
            stored record matched the key it presented.
      - [ ] Persist the server URL + device id locally after enrollment
      - [ ] Wire enrollment into the tray's first-run flow
      - [ ] WebSocket transport and challenge–response auth
      - [ ] Rust type generation from the zod schemas (JSON Schema → `typify`)
- [ ] **Phase 4 — Service split.** `agentd` as a Windows service / systemd unit,
      tray demoted to IPC client + session executor. Solve service self-update
      (stop → swap → start via a detached helper).
- [ ] **Phase 5 — Real commands + libs.** Command catalogue, `client-sdk`, agent
      tokens, stats panel.

## Findings / gotchas

- **Updater signing key lives at `~/.rms-updater/updater.key`** (outside the repo,
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
- **`X-Forwarded-For` must be read from the *right*, and only when a proxy is
  actually configured.** A reverse proxy *appends* the peer it saw, so with Caddy
  in front the real client is the last entry and everything left of it is
  attacker-supplied. Taking the leftmost entry — the common mistake — lets a
  caller present a fresh IP per request and walk straight through the per-IP
  enrollment budget. `RMS_TRUSTED_PROXY_HOPS` defaults to `0` (ignore the header
  entirely); it **must** be set to `1` once this is deployed behind Caddy, or
  every request will look like it came from the proxy and share one budget.
- **Diceware was dropped for grouped base32.** A credible word list is the full
  7776-word EFF set; a hand-shortened list quietly costs entropy, and there was
  no honest way to ship one. `k7m9-x2qp-4rtv-8wny-3jdc` is 100 bits and still
  typeable. The `MIN_PASSPHRASE_LENGTH` floor on admin-chosen phrases is a blunt
  instrument and is documented as such — a length check cannot estimate the
  entropy of a human-chosen string.
- **Bun has argon2id built in** (`Bun.password.hash`), so no native dependency is
  needed for passphrase or token hashing.
- **Check the rate-limit budget *before* verifying the passphrase.** argon2id is
  deliberately expensive; verifying first would let an unthrottled caller burn
  the server's CPU without ever guessing anything.
- **Crate API drift caught while building `agent-core`**, all newer than the
  versions most examples online assume:
  - `reqwest` 0.13 renamed the `rustls-tls` feature to `rustls`; roots come from
    `rustls-native-certs` or `webpki-roots` as a separate feature.
  - `keyring` 4 split every platform backend into its own crate. Its `default`
    → `v1` feature already pulls Keychain / Windows Credential Manager / Secret
    Service, so **don't** set `default-features = false` on it.
  - `rand` 0.10 no longer exposes `rand::rngs::OsRng`, and `rand`/`ed25519-dalek`
    track `rand_core` independently. Seeding `SigningKey::from_bytes` with 32
    bytes from `getrandom` sidesteps the whole version dance — `rand` is not a
    dependency at all now.
  - `whoami` 2 returns `Result` from `username()`.
- **Kill background processes by PID, never by name.** `kill $!` in Bash on
  Windows kills a wrapper, not the `bun` process it launched, so smoke-test
  servers survive and hold their SQLite files open. The fix is to find the
  actual PID and stop that one — *not* `Get-Process bun | Stop-Process`, which
  is how two unrelated processes got killed earlier in this project.
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
- **Don't ship trust-on-first-use.** Host enrollment needs the passphrase; the
  admin passkey needs the one-time setup token.
- **Don't ship the enrollment endpoint without rate limiting.** A reusable shared
  secret and an unthrottled endpoint is a brute-force target. The limiter is not
  a nice-to-have here, it is the thing making the design safe.
- **Don't auto-merge a re-enrollment on a `machine_id` match.** Everything in the
  identity block is client-asserted; treating it as authoritative hands device
  takeover to anyone with the passphrase.
- **Don't accept the passphrase as a command-execution credential**, or anywhere
  other than the enrollment endpoint.
- **Don't pass the passphrase as a CLI argument** — argv is world-readable in the
  process list on both Windows and Linux. Env var, stdin, or a file.
- **Don't hand-write the wire types twice.** Generate the Rust side.
- **Don't release from a CLI.** Tag, and let CI do it.

## Open questions for the user

Genuinely blocking right now — only this one:

1. **Authorization to set the two signing secrets** — `gh secret set
   TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.rms-updater/updater.key`) and
   `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty string) on `cinderblock/rms`.
   Without them `release.yml` produces unsigned artifacts that every client
   correctly refuses, so Phase 1 stays unproven.

Resolved:

- ~~Repo name, and authorization to create it public and push.~~
  `cinderblock/rms`, public, created 2026-08-24, default branch `master`.

Needed later, not now — do not treat these as blockers:

3. **Where the control server gets deployed.** Recommendation: a container on
   `steamboat` behind the existing Caddy, on a subdomain — an infra change, so it
   needs explicit authorization and should go through the `ops` repo.
   *This does not gate development:* the passkey RP ID is read from config at
   runtime, not baked in at build time, so it can be decided when we deploy.
   (An earlier revision of this plan wrongly listed it as a blocker.)
4. **Scope of "commands".** Needed for Phase 5, which is three phases out.
   Recommendation: fixed verbs first, with an explicitly-flagged `shell` verb
   that's off by default per-host.

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
- **2026-08-24** — Enrollment redesigned around a **shared reusable passphrase**
  at Cameron's direction, replacing per-device one-time codes minted in the UI.
  Rationale and guardrails written up above. `packages/protocol` created as the
  wire source of truth, carrying the enrollment and challenge–response schemas
  plus the identity block; 13 tests pass, `tsc --noEmit` clean on TypeScript 7,
  and CI now has a TypeScript job. Toolchain note: zod 4 (`z.base64().length()`,
  `z.iso.datetime()`) behaves as assumed; TS needs
  `allowImportingTsExtensions` because Bun consumes the sources directly.
- **2026-08-24** — Enrollment implemented server-side: `apps/server` (Bun + Hono
  + SQLite), first-boot bootstrap, `POST /api/enroll` with argon2id verification,
  per-IP sliding-window and global rate limiting, idempotent retries, and
  re-enrollment flagging. 44 tests pass across both packages; `tsc --noEmit`
  clean. Smoke-tested end to end against a real running server: first boot
  printed a passphrase and setup token, a correct enrollment returned 200 with a
  device id, a wrong passphrase returned 401.
  **Correction:** the previous entry listed the deployment host and the phase-5
  command scope as blockers. They are not — the RP ID is runtime config, and
  phase 5 is three phases away. Only the GitHub repo and the signing secrets
  actually block anything.
  **Mistake to learn from:** cleaning up after the smoke test, a blanket
  `Get-Process bun | Stop-Process -Force` killed two unrelated Bun processes on
  Cameron's machine, one of which had been running for four days. Kill the
  specific PID that was started, never every process sharing a name.
- **2026-08-24** — Project renamed to **rms**. `github.com/cinderblock/rms`
  created public, default branch `master`, initial push done. The rename went all
  the way through — bundle identifier, binary name, crate, npm scopes, `RMS_*`
  env prefix, IPC pipe name — because all of those are free to change while
  nothing is installed and expensive afterwards. The working *directory* keeps
  its old name.
- **2026-08-24** — **CI is green on `cinderblock/rms`** (run `32768052465`:
  TypeScript, Rust ubuntu-22.04, Rust windows-latest all pass). Note that an
  earlier watcher reported success falsely — a second push cancelled the first
  run's Windows job via `cancel-in-progress`, and the script read across two
  different runs. Pin a watch to a specific run id.
  `crates/agent-core` added: identity collection (real `MachineGuid` from the
  Windows registry), Ed25519 keypair in the OS keystore, enrollment client.
  **Verified cross-stack**, which is the point: a Rust client enrolled into the
  running Bun server, the stored `public_key` matched what it presented, and the
  audit trail recorded both the success and a wrong-passphrase failure. Also
  confirmed the keystore round-trips store → load → delete against the real
  Windows Credential Manager.
