# aspire

A [Paseo](https://paseo.sh) plugin that adds an **Aspire** button to the header of every workspace that contains a .NET Aspire app host.

- **Idle:** pressing the button starts the app host in the background with `aspire start`.
- **Starting / running:** the button opens a popover with:
  - the app host state, with icon buttons to open the dashboard, view all logs, restart and stop,
  - every resource with its state, health and endpoint URLs, plus icon buttons to start or stop it (whichever it
    currently offers, as in the dashboard), view its logs, and open it in the dashboard.

  Icon buttons show their label as a tooltip on desktop.
- **Logs:** an **Aspire logs** workspace panel streams console output from the app host's resources. Pick **All** or a single resource. You can filter lines, show timestamps, follow the tail, copy and clear. Lines keep the colors and styles the resource wrote (ANSI 16/256/truecolor, bold, italic, underline), stderr lines get a **stderr** badge like the Aspire dashboard, and URLs are clickable. The **All** view labels each line with a colored resource badge; single-resource views show line numbers. Text uses the same monospace stack and size as Paseo's terminal. The dropdown's view-logs buttons open the panel on all resources or on one resource.
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
- **Resources:** one long-lived `aspire describe --apphost <path> --format Json --follow` per running app host, which sends each resource again whenever it changes. Resources are never polled from the CLI: every CLI run writes a log file to `~/.aspire/logs` and opens a connection to the app host.
- **Logs:** one `aspire logs --apphost <path> --format Json --follow -n 2000 -t` per app host, covering every resource and buffered on the daemon (up to 20,000 lines). Like the Aspire dashboard, resource tabs filter this one stream on the client, so switching tabs needs no loading. The backlog the CLI replays on connect is held back until it has all arrived (the stream goes quiet briefly), and the panel's first read waits for it, so it arrives in one piece. After that the panel polls every second with a cursor. A stream nobody has read for five minutes is shut down.
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
- `server/logs.ts`: buffered log streams for the logs panel.
- `server/monitor.ts`: the `ps` stream, start, stop, restart and resources.
- `server/state.ts`: path normalization and the remembered app host selection.
- `server/aspire.ts`: RPC handlers.
- `client/header-button.ts`: one header button per workspace, plus polling.
- `client/aspire-popover.tsx`: the popover content.
- `client/logs-panel.tsx`: the Aspire logs workspace panel.
- `client/ansi-text.tsx`: renders ANSI-styled log segments.
- `shared/ansi.ts`: ANSI escape parser (runs on the daemon).
- `client/logs-target.ts`: which resource the logs panel shows, shared with the popover.
- `client/aspire-icon.tsx`: the Aspire logo with the status dot.
