import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { copyText, Icon } from "@getpaseo/plugin/client/react-native";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { AppHost, AspireResource, AspireResources, AspireStatus, ResourceCommand } from "../shared/aspire";
import { isResourceUnhealthy } from "../shared/aspire";
import { isTouchLayout, TouchContext, useTouch } from "./touch";
import { useWebTooltip } from "./web-tooltip";

const RESOURCE_POLL_MS = 3_000;
const POPOVER_WIDTH = 360;
const HEADER_ICON_SIZE = 18;
// Whole-pixel line heights for every text size. Without them the browser uses the font's fractional "normal" line
// height, so rows land on sub-pixel positions: the host's open animation (a scale) renders them smoothly, then they
// snap to the pixel grid when it ends (a visible jump), and the popover's content-sized scroll area ends up a hair
// shorter than its content, so drag-selecting text scrolls it slightly.
const LINE_HEIGHTS: Record<number, number> = { 12: 16, 13: 18, 14: 20 };
function textSize(size: number) {
  return { fontSize: size, lineHeight: LINE_HEIGHTS[size] ?? Math.ceil(size * 1.4) };
}

export type PopoverState = {
  status: AspireStatus;
  appHosts: AppHost[];
  selected: string | null;
  cliAvailable: boolean;
  resources: AspireResources | null;
  actionError: string | null;
};

export type PopoverModel = {
  subscribe(listener: () => void): () => void;
  getVersion(): number;
  getState(): PopoverState;
  refreshResources(): Promise<void>;
  open(url: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  restart(): Promise<void>;
  select(path: string): Promise<void>;
  /** Opens the logs panel on one resource, or on every resource when null. */
  openLogs(resource: string | null): void;
  /** Starts or stops one resource; resolves once the CLI has run it (the resource list is refreshed after). */
  resourceCommand(resource: string, command: ResourceCommand): Promise<void>;
};

export function describeError(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function displayUrl(url: string) {
  const match = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i.exec(url);
  if (!match) return url;
  const [, host, path] = match;
  return path && path !== "/" ? `${host}${path}` : host;
}

function statusText(status: AspireStatus, error: string | null) {
  switch (status.state) {
    case "running":
      return status.pid ? `Running (PID ${status.pid})` : "Running";
    case "starting":
      return "Starting…";
    case "stopping":
      return "Stopping…";
    default:
      return error ? "Failed" : "Not running";
  }
}

function statusColor(theme: PluginTheme, status: AspireStatus, error: string | null) {
  if (status.state === "running") return theme.colors.statusSuccess;
  if (status.state !== "idle") return theme.colors.statusWarning;
  return error ? theme.colors.statusDanger : theme.colors.foregroundMuted;
}

function resourceColor(theme: PluginTheme, resource: AspireResource) {
  const { state, health } = resource;
  if (isResourceUnhealthy(resource)) return theme.colors.statusDanger;
  if (state === "Running") return health === null || health === "Healthy" ? theme.colors.statusSuccess : theme.colors.statusWarning;
  if (state === "Starting" || state === "Waiting" || state === "NotStarted") return theme.colors.statusWarning;
  return theme.colors.foregroundMuted;
}

function Dot({ color }: { color: string }) {
  return <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: color }} />;
}

function Button({
  theme,
  label,
  onPress,
  disabled,
  tone = "default",
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  disabled?: boolean;
  tone?: "default" | "accent";
}) {
  const accent = tone === "accent";
  const touch = useTouch();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      hitSlop={touch ? 6 : undefined}
      style={({ pressed }) => ({
        paddingHorizontal: touch ? 14 : 12,
        paddingVertical: touch ? 9 : 6,
        borderRadius: 6,
        borderWidth: accent ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: accent ? theme.colors.accent : pressed ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.5 : pressed && accent ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          ...textSize(touch ? 14 : 13),
          fontWeight: "600",
          color: accent ? theme.colors.accentForeground : theme.colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

/**
 * A small icon-only button. `icon` is a Lucide icon name, rendered with Paseo's bundled icon set. On web the label
 * shows in a tooltip styled like Paseo's own (the SDK doesn't expose Paseo's tooltip component).
 */
function IconAction({
  theme,
  icon,
  label,
  onPress,
  disabled = false,
  busy = false,
  size = 16,
  color,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  busy?: boolean;
  size?: number;
  color?: string;
}) {
  const tint = color ?? theme.colors.foregroundMuted;
  const touch = useTouch();
  // On phones: a larger glyph and padding so the target (with hitSlop) is ~44pt.
  const glyph = touch ? size + 4 : size;
  const ref = useRef<View>(null);
  useWebTooltip(ref, label, theme);
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: disabled || busy, busy }}
      hitSlop={6}
      disabled={disabled || busy}
      onPress={onPress}
      style={({ pressed }) => ({
        padding: touch ? 8 : 4,
        borderRadius: touch ? 8 : 6,
        opacity: disabled ? 0.4 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : "transparent",
      })}
    >
      {busy ? <ActivityIndicator size={glyph} color={tint} /> : <Icon name={icon} size={glyph} color={tint} />}
    </Pressable>
  );
}

function Link({ theme, label, url, onOpen }: { theme: PluginTheme; label: string; url: string | null; onOpen(url: string): void }) {
  const touch = useTouch();
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={url ? `Open ${label}` : `${label} (not available yet)`}
      disabled={!url}
      onPress={() => url && onOpen(url)}
      hitSlop={touch ? { top: 12, bottom: 12, left: 8, right: 8 } : undefined}
      style={({ pressed }) => ({ opacity: !url ? 0.5 : pressed ? 0.7 : 1 })}
    >
      <Text numberOfLines={1} style={{ ...textSize(touch ? 14 : 12), color: url ? theme.colors.accent : theme.colors.foregroundMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function createAspirePopover(model: PopoverModel) {
  return function AspirePopover({ theme, close, layout }: PluginButtonContentProps) {
    useSyncExternalStore(model.subscribe, model.getVersion, model.getVersion);
    const { status, appHosts, selected, cliAvailable, resources, actionError } = model.getState();
    const touch = isTouchLayout(layout);
    const [pending, setPending] = useState<string | null>(null);
    const [openError, setOpenError] = useState<string | null>(null);
    // The `${resource}:${command}` currently running, so its button shows a spinner.
    const [pendingCommand, setPendingCommand] = useState<string | null>(null);
    const running = status.state === "running";
    const error = actionError ?? status.error;
    const current = appHosts.find((host) => host.path === (status.appHostPath ?? selected)) ?? null;

    useEffect(() => {
      if (!running) return;
      let live = true;
      let handle: ReturnType<typeof setTimeout> | null = null;
      const load = async () => {
        await model.refreshResources();
        if (live) handle = setTimeout(load, RESOURCE_POLL_MS);
      };
      void load();
      return () => {
        live = false;
        if (handle) clearTimeout(handle);
      };
    }, [running]);

    const act = (label: string, action: () => Promise<void>) => {
      setPending(label);
      void action().finally(() => setPending(null));
    };

    const open = (url: string) => {
      setOpenError(null);
      model.open(url).then(close, (e: unknown) => setOpenError(describeError(e)));
    };

    const runCommand = (resource: AspireResource, command: ResourceCommand) => {
      setOpenError(null);
      setPendingCommand(`${resource.name}:${command}`);
      model
        .resourceCommand(resource.name, command)
        .catch((e: unknown) => setOpenError(`Couldn't ${command} ${resource.displayName}: ${describeError(e)}`))
        .finally(() => setPendingCommand(null));
    };

    const openLogs = (resource: string | null) => {
      model.openLogs(resource);
      close();
    };

    const muted = { ...textSize(12), color: theme.colors.foregroundMuted } as const;
    const visible = resources?.resources ?? [];

    return (
      <TouchContext.Provider value={touch}>
        <View style={layout.compact ? { gap: 10, alignSelf: "stretch" } : { gap: 10, width: POPOVER_WIDTH }}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
            <View style={{ flex: 1, gap: 2 }}>
              <Text numberOfLines={1} style={{ color: theme.colors.foreground, ...textSize(14), fontWeight: "600" }}>
                {current ? current.relativePath : "Aspire app host"}
              </Text>
              <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                <Dot color={statusColor(theme, status, error)} />
                <Text style={{ ...textSize(12), color: statusColor(theme, status, error) }}>{statusText(status, error)}</Text>
                {status.state === "starting" || status.state === "stopping" ? <ActivityIndicator size="small" /> : null}
              </View>
            </View>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
              {running || status.state === "stopping" ? (
                <>
                  <IconAction
                    theme={theme}
                    icon="LayoutDashboard"
                    label={status.dashboardUrl ? "Open dashboard" : "Dashboard URL not known yet"}
                    size={HEADER_ICON_SIZE}
                    disabled={!status.dashboardUrl}
                    onPress={() => status.dashboardUrl && open(status.dashboardUrl)}
                  />
                  <IconAction theme={theme} icon="Logs" label="View all logs" size={HEADER_ICON_SIZE} onPress={() => openLogs(null)} />
                </>
              ) : null}
              {status.state === "idle" ? (
                <Button
                  theme={theme}
                  tone="accent"
                  label={pending === "start" ? "Starting…" : "Start"}
                  disabled={!selected || !cliAvailable || pending !== null}
                  onPress={() => act("start", model.start)}
                />
              ) : null}
              {running ? (
                <IconAction
                  theme={theme}
                  icon="RotateCw"
                  label="Restart app host"
                  size={HEADER_ICON_SIZE}
                  busy={pending === "restart"}
                  disabled={pending !== null}
                  onPress={() => act("restart", model.restart)}
                />
              ) : null}
              {status.state === "running" || status.state === "starting" ? (
                <IconAction
                  theme={theme}
                  icon="Square"
                  label="Stop app host"
                  size={HEADER_ICON_SIZE}
                  color={theme.colors.statusDanger}
                  busy={pending === "stop"}
                  disabled={pending !== null}
                  onPress={() => act("stop", model.stop)}
                />
              ) : null}
            </View>
          </View>

          {!cliAvailable ? (
            <Text style={{ ...textSize(12), color: theme.colors.statusWarning }}>
              The Aspire CLI (13.5 or newer) was not found on the Paseo daemon's PATH. Install it from https://aspire.dev.
            </Text>
          ) : null}

          {appHosts.length > 1 ? (
            <View style={{ gap: 4 }}>
              <Text style={muted}>App host</Text>
              {appHosts.map((host) => {
                const isSelected = host.path === selected;
                const locked = status.state !== "idle";
                return (
                  <Pressable
                    key={host.path}
                    accessibilityRole="radio"
                    accessibilityState={{ selected: isSelected, disabled: locked }}
                    disabled={locked}
                    onPress={() => act("select", () => model.select(host.path))}
                    style={({ pressed }) => ({
                      flexDirection: "row",
                      alignItems: "center",
                      gap: 8,
                      paddingVertical: touch ? 12 : 4,
                      paddingHorizontal: touch ? 10 : 6,
                      borderRadius: 6,
                      backgroundColor: pressed || isSelected ? theme.colors.surface2 : "transparent",
                      opacity: locked && !isSelected ? 0.5 : 1,
                    })}
                  >
                    <View
                      style={{
                        width: 12,
                        height: 12,
                        borderRadius: 6,
                        borderWidth: 1.5,
                        borderColor: isSelected ? theme.colors.accent : theme.colors.border,
                        backgroundColor: isSelected ? theme.colors.accent : "transparent",
                      }}
                    />
                    <Text numberOfLines={1} style={{ flex: 1, ...textSize(12), color: theme.colors.foreground }}>
                      {host.relativePath}
                    </Text>
                  </Pressable>
                );
              })}
            </View>
          ) : null}

          {error ? (
            <View style={{ gap: 4, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface1 }}>
              <Text style={{ ...textSize(12), color: theme.colors.statusDanger }}>{error}</Text>
              {status.logFilePath ? (
                <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
                  <Text numberOfLines={1} style={[muted, { flex: 1 }]}>
                    {status.logFilePath}
                  </Text>
                  <Button theme={theme} label="Copy path" onPress={() => void copyText(status.logFilePath!)} />
                </View>
              ) : null}
            </View>
          ) : null}

          {running || status.state === "stopping" ? (
            <>
              <View style={{ height: 1, backgroundColor: theme.colors.border }} />
              <Text style={muted}>Resources</Text>
              {resources === null ? <ActivityIndicator size="small" /> : null}
              {resources?.error ? <Text style={{ ...textSize(12), color: theme.colors.statusDanger }}>{resources.error}</Text> : null}
              {resources && !resources.error && visible.length === 0 ? <Text style={muted}>No resources reported yet.</Text> : null}
              {visible.map((resource) => (
                // Name and URLs in one column, buttons in another, so the (larger, on phones) buttons don't push the
                // URLs away from the name.
                <View key={resource.name} style={{ flexDirection: "row", alignItems: touch ? "center" : "flex-start", gap: 6 }}>
                  <View style={{ flex: 1, gap: 2 }}>
                    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                      <Dot color={resourceColor(theme, resource)} />
                      <Text numberOfLines={1} style={{ flexShrink: 1, ...textSize(13), color: theme.colors.foreground }}>
                        {resource.displayName}
                      </Text>
                      <Text style={muted}>{[resource.type, resource.health ?? resource.state].filter(Boolean).join(" · ")}</Text>
                    </View>
                    {resource.urls.map((url) => (
                      <View key={url.url} style={{ paddingLeft: 14 }}>
                        <Link theme={theme} label={displayUrl(url.url)} url={url.url} onOpen={open} />
                      </View>
                    ))}
                  </View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    {/* Like the dashboard: offer whichever of start/stop the resource currently lists. */}
                    {(["start", "stop"] as const).map((command) => {
                      const available = resource.commands[command];
                      if (!available) return null;
                      return (
                        <IconAction
                          key={command}
                          theme={theme}
                          icon={command === "start" ? "Play" : "Square"}
                          label={`${command === "start" ? "Start" : "Stop"} ${resource.displayName}`}
                          disabled={!available.enabled}
                          busy={pendingCommand === `${resource.name}:${command}`}
                          onPress={() => runCommand(resource, command)}
                        />
                      );
                    })}
                    <IconAction theme={theme} icon="Logs" label={`View ${resource.displayName} logs`} onPress={() => openLogs(resource.name)} />
                    {resource.dashboardUrl ? (
                      <IconAction
                        theme={theme}
                        icon="ExternalLink"
                        label={`Open ${resource.displayName} in the dashboard`}
                        onPress={() => open(resource.dashboardUrl!)}
                      />
                    ) : null}
                  </View>
                </View>
              ))}
            </>
          ) : null}

          {openError ? <Text style={{ ...textSize(12), color: theme.colors.statusDanger }}>{openError}</Text> : null}
        </View>
      </TouchContext.Provider>
    );
  };
}
