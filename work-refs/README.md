# work-refs

A [Paseo](https://paseo.sh) plugin that draws GitHub (`#123`) and Azure Boards (`AB#123`) references in agent replies as inline chips, in place of the reference, with its number, title, a state-colored icon and a link.

- **Timeline:** in completed assistant messages, each `#123` or `AB#123` outside code, links and URLs that resolves becomes a chip in the line of text. Hover (desktop and web) for the type and state; click to open it. On iOS and Android the chip shows as a link with the number and title. References that don't resolve stay as written.
- **Settings → Plugins → Work Item Links:** per project, the default GitHub repository (`owner/repo`) for `#123`, and the Azure DevOps organization and project for `AB#123`. Empty fields fall back to the project's `origin` remote (GitHub, `dev.azure.com` and `visualstudio.com` URLs), shown as placeholders.

## Requirements

- Paseo 0.16.1 or newer.
- On the daemon's host: the GitHub CLI signed in (`gh auth login`), or `GH_TOKEN`/`GITHUB_TOKEN`; and the Azure CLI signed in (`az login`), or a personal access token in `AZURE_DEVOPS_EXT_PAT`.

## Install

```bash
npm install
npm run typecheck
npm test
paseo plugin install /absolute/path/to/paseo-plugins/work-refs
```

After editing, `paseo plugin reload work-refs`.

## How it works

**Detection** (`shared/refs.ts`) skips fenced and inline code, Markdown links and images, autolinks and bare URLs, then matches `#N` and `AB#N` (case-insensitive) not preceded by a word character, `&`, `#` or `/`. The transformer only claims messages once they're complete, so a half-streamed `#12` is never looked up, and messages without references stay Paseo's own rows.

**Inline chips.** Paseo's `Markdown` component takes a string and has no inline extension point, so the whole message still goes through it, with each resolved reference replaced by a linked image: `[![#123 Title](data:image/svg+xml…)](url)` (`shared/chip-svg.ts`). Paseo shows an image that shares a line with text inline at line height, and keeps a linked image inline. A zero-width space follows each chip so a reference alone on its line isn't promoted to a block image. The SVG is drawn in the theme's colors with Lucide icons; since an image can't measure text, the chip is sized from Helvetica/Arial widths with the font pinned to Arial and `textLength` absorbing any difference. The image title is the tooltip. iOS and Android can't show SVG images, so they show the alt text (`#123 Title`), still linked.

**Settings.** Paseo settings are host- or device-scoped, so one host document (`projects`) holds each project's values keyed by project ID.

**Lookups** run on the daemon (`server/resolve.ts`). Timeline rows don't get Paseo's plugin providers (state hooks, `useRpc`), so the renderer sends only the agent ID through the contribution's `client.rpc`, and the server finds the agent's workspace and project with `context.paseo`. GitHub uses `GET /repos/{repo}/issues/{n}`, which covers issues and pull requests (state is open, draft, merged or closed). Azure DevOps reads all of a message's work items in one `GET _apis/wit/workitems?ids=…&errorPolicy=omit`. Each work item type's icon (`_apis/wit/workItemIcons`, in the type's color) and state colors (`workitemtypes/{type}`) are fetched once an hour per organization, project and type, so chips show the process's own icons (custom types such as Defect included) and a dot in the state's color; without them the chip falls back to a Lucide icon. The icon must be a plain SVG (no scripts, event handlers or external references) before it's embedded. Tokens come from the environment or the CLIs and are cached until they expire. Results are cached for five minutes (one for misses), and saving settings clears the cache. A failed lookup shows no chip and is logged.
