# remote-mgmt-daemon

A thin client that installs on your machines, dials home to a self-hosted control
server over an outbound WebSocket, and executes commands. Plus the control server
itself, which serves a small management UI behind passkey-only authentication.

**Status: early. Phase 1 of 5.** The tray client and its self-updater exist; the
control server does not yet. See [`plans/architecture.md`](plans/architecture.md)
for the full design, the decisions already locked in, and what's next.

## Why the updater came first

A fleet agent that can't fix itself in the field is a fleet agent you have to
visit in person. So the update path is the first thing built, and it deliberately
does **not** depend on the control server: clients check a signed `latest.json`
published to GitHub Releases by CI. If the server is down — or is itself the
thing that broke — updates still land.

There are three ways to trigger a check, for the same reason:

| Trigger | Cadence |
|---|---|
| Ambient timer | hourly, 30s after launch |
| Tray menu → *Check for updates now* | on demand |
| Control server push *(phase 3)* | on demand, fleet-wide |

Every update is signed with a minisign key held only in GitHub Actions secrets,
and verified against a public key compiled into the client. An unsigned or
mis-signed artifact is refused.

## Layout

```
apps/tray/          Tauri tray app — status window, update triggers, and
                    (from phase 4) the user-session command executor
apps/agentd/        privileged background service                 [phase 4]
apps/server/        Bun + Hono control server & management UI      [phase 2]
crates/             shared Rust: transport, wire types, local IPC  [phase 3+]
packages/           TypeScript: wire schemas, client SDK, web UI   [phase 2+]
plans/              living design docs — read these first
```

## Developing

Requires [Bun](https://bun.sh) and a stable Rust toolchain. On Linux you also
need `libwebkit2gtk-4.1-dev`, `libappindicator3-dev`, `librsvg2-dev` and
`patchelf`; see [`.github/workflows/ci.yml`](.github/workflows/ci.yml) for the
exact list CI installs.

```sh
bun install
bun run tray:dev      # run the tray app with hot reload
bun run tray:build    # produce a local bundle
bun run check         # fmt + clippy, same as CI
```

The tray app registers itself for autostart at login on first run. Quit it from
the tray menu; closing the status window only hides it.

Set `RMD_LOG=debug` for verbose logging.

## Releasing

Releases only ever happen in CI.

1. Bump `version` in `apps/tray/src-tauri/tauri.conf.json`.
2. Commit, then tag `vX.Y.Z` and push the tag.
3. `.github/workflows/release.yml` builds Windows, Linux and macOS, signs the
   updater artifacts, and publishes a GitHub Release containing `latest.json`.

The workflow refuses to run if the tag and the configured version disagree — a
mismatch there would silently break every client's "is there something newer?"
comparison.

### One-time setup

The updater signing keypair is generated with `bunx tauri signer generate`. The
**public** key lives in `tauri.conf.json` and is compiled into every client. The
**private** key must exist only as two repository secrets:

- `TAURI_SIGNING_PRIVATE_KEY` — contents of the private key file
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — its passphrase (empty if none)

Losing the private key means no existing client can ever be updated again, since
they will reject anything signed by a different key. Back it up somewhere that
isn't this repository.

### macOS

macOS builds are unsigned and un-notarised — a deliberate choice to avoid the
$99/yr Apple Developer Program for personal use. Gatekeeper will block the first
launch; right-click → Open, once, per machine.

## License

MIT
