# aspire

A [Paseo](https://paseo.sh) plugin that adds an **Aspire** button to the header of every workspace that contains a .NET Aspire app host.

- **Idle:** pressing the button starts the app host in the background with `aspire start`.
- **Starting / running:** the button opens a popover with:
  - the app host state,
  - an **Open dashboard** link,
  - every resource with its state, health and endpoint URLs,
  - **Restart** and **Stop**.
- **Status dot:** the button's icon shows a dot. Green means running, amber means starting or stopping, red means the last start failed.

## Requirements

- Paseo 0.10.3 or newer, with plugins enabled on the daemon.
- [Aspire CLI](https://aspire.dev) 13.5 or newer on the daemon's `PATH`.

## Detection

The plugin looks for app hosts in the workspace directory in two ways:

1. **Configuration:** `appHost.path` in the nearest `aspire.config.json`, searching upward from the workspace directory. It also reads `appHostPath` in the older `.aspire/settings.json`.
2. **Scan:** a scan of the workspace. It skips `bin`, `obj`, `node_modules`, `.git` and `.aspire`, and goes at most six directories deep. It matches:
   - `*.csproj` files that use `Aspire.AppHost.Sdk`, set `IsAspireHost`, or reference `Aspire.Hosting.AppHost`;
   - `apphost.cs` files with `#:sdk Aspire.AppHost.Sdk`;
   - `apphost.ts` or `apphost.mts` files under an `aspire.config.json`.

Workspaces without a match get no button.

If a workspace has more than one app host, the configured one is used. Otherwise the popover shows a picker, and the choice is remembered in `~/.paseo/plugin-state/aspire/selection.json`.

## How state is tracked

Everything goes through the Aspire CLI on the daemon machine:

- **Running app hosts:** one long-lived `aspire ps --format Json --follow` stream. This includes app hosts started outside Paseo, for example from a terminal.
  - A one-shot `aspire ps` (without `--follow`) stops "orphaned" app hosts as a side effect, so the plugin never runs it.
- **Resources:** `aspire describe --apphost <path> --format Json`, polled while the popover is open and cached for two seconds.
- **Start, stop and restart:** `aspire start --apphost <path>` and `aspire stop --apphost <path>`.
- **Archiving:** archiving a workspace stops its running app host.

## Install

```bash
npm install
npm run typecheck
paseo plugin install /absolute/path/to/paseo-plugins/aspire
```

## Layout

- `shared/aspire.ts`: RPC contracts and schemas.
- `server/cli.ts`: spawns the Aspire CLI, follows `--follow` streams and checks the CLI version.
- `server/detect.ts`: app host discovery.
- `server/monitor.ts`: the `ps` stream, start, stop, restart and resources.
- `server/state.ts`: path normalization and the remembered app host selection.
- `server/aspire.ts`: RPC handlers.
- `client/header-button.ts`: one header button per workspace, plus polling.
- `client/aspire-popover.tsx`: the popover content.
- `client/aspire-icon.tsx`: the Aspire logo with the status dot.
