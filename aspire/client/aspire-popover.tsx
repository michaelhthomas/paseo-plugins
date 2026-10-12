import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginButtonContentProps } from "@getpaseo/plugin/client";
import { copyText } from "@getpaseo/plugin/client/react-native";
import { useEffect, useState, useSyncExternalStore } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import type { AppHost, AspireResource, AspireResources, AspireStatus } from "../shared/aspire";

const RESOURCE_POLL_MS = 3_000;
const POPOVER_WIDTH = 360;

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
  const { state, health, exitCode } = resource;
  if (state === "FailedToStart" || health === "Unhealthy") return theme.colors.statusDanger;
  if ((state === "Exited" || state === "Finished") && exitCode !== null && exitCode !== 0) return theme.colors.statusDanger;
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
  tone?: "default" | "danger" | "accent";
}) {
  const accent = tone === "accent";
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => ({
        paddingHorizontal: 10,
        paddingVertical: 5,
        borderRadius: 6,
        borderWidth: accent ? 0 : 1,
        borderColor: theme.colors.border,
        backgroundColor: accent ? theme.colors.accent : pressed ? theme.colors.surface2 : theme.colors.surface1,
        opacity: disabled ? 0.5 : pressed && accent ? 0.85 : 1,
      })}
    >
      <Text
        style={{
          fontSize: 12,
          fontWeight: "600",
          color: accent ? theme.colors.accentForeground : tone === "danger" ? theme.colors.statusDanger : theme.colors.foreground,
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function Link({ theme, label, url, onOpen }: { theme: PluginTheme; label: string; url: string | null; onOpen(url: string): void }) {
  return (
    <Pressable
      accessibilityRole="link"
      accessibilityLabel={url ? `Open ${label}` : `${label} (not available yet)`}
      disabled={!url}
      onPress={() => url && onOpen(url)}
      style={({ pressed }) => ({ opacity: !url ? 0.5 : pressed ? 0.7 : 1 })}
    >
      <Text numberOfLines={1} style={{ fontSize: 12, color: url ? theme.colors.accent : theme.colors.foregroundMuted }}>
        {label}
      </Text>
    </Pressable>
  );
}

export function createAspirePopover(model: PopoverModel) {
  return function AspirePopover({ theme, close, layout }: PluginButtonContentProps) {
    useSyncExternalStore(model.subscribe, model.getVersion, model.getVersion);
    const { status, appHosts, selected, cliAvailable, resources, actionError } = model.getState();
    const [pending, setPending] = useState<string | null>(null);
    const [openError, setOpenError] = useState<string | null>(null);
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

    const muted = { fontSize: 12, color: theme.colors.foregroundMuted } as const;
    const visible = resources?.resources ?? [];

    return (
      <View style={layout.compact ? { gap: 10, alignSelf: "stretch" } : { gap: 10, width: POPOVER_WIDTH }}>
        <View style={{ flexDirection: "row", alignItems: "center", gap: 12 }}>
          <View style={{ flex: 1, gap: 2 }}>
            <Text numberOfLines={1} style={{ color: theme.colors.foreground, fontSize: 14, fontWeight: "600" }}>
              {current ? current.relativePath : "Aspire app host"}
            </Text>
            <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
              <Dot color={statusColor(theme, status, error)} />
              <Text style={{ fontSize: 12, color: statusColor(theme, status, error) }}>{statusText(status, error)}</Text>
              {status.state === "starting" || status.state === "stopping" ? <ActivityIndicator size="small" /> : null}
            </View>
          </View>
          <View style={{ flexDirection: "row", gap: 6 }}>
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
              <Button theme={theme} label="Restart" disabled={pending !== null} onPress={() => act("restart", model.restart)} />
            ) : null}
            {status.state === "running" || status.state === "starting" ? (
              <Button
                theme={theme}
                tone="danger"
                label={pending === "stop" ? "Stopping…" : "Stop"}
                disabled={pending !== null}
                onPress={() => act("stop", model.stop)}
              />
            ) : null}
          </View>
        </View>

        {!cliAvailable ? (
          <Text style={{ fontSize: 12, color: theme.colors.statusWarning }}>
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
                    paddingVertical: 4,
                    paddingHorizontal: 6,
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
                  <Text numberOfLines={1} style={{ flex: 1, fontSize: 12, color: theme.colors.foreground }}>
                    {host.relativePath}
                  </Text>
                </Pressable>
              );
            })}
          </View>
        ) : null}

        {error ? (
          <View style={{ gap: 4, padding: 8, borderRadius: 6, backgroundColor: theme.colors.surface1 }}>
            <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>{error}</Text>
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
            <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between" }}>
              <Link theme={theme} label="Open dashboard" url={status.dashboardUrl} onOpen={open} />
              {status.dashboardUrl ? <Text style={muted}>{displayUrl(status.dashboardUrl)}</Text> : null}
            </View>
            <View style={{ height: 1, backgroundColor: theme.colors.border }} />
            <Text style={muted}>Resources</Text>
            {resources === null ? <ActivityIndicator size="small" /> : null}
            {resources?.error ? <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>{resources.error}</Text> : null}
            {resources && !resources.error && visible.length === 0 ? <Text style={muted}>No resources reported yet.</Text> : null}
            {visible.map((resource) => (
              <View key={resource.name} style={{ gap: 2 }}>
                <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                  <Dot color={resourceColor(theme, resource)} />
                  <Text numberOfLines={1} style={{ flexShrink: 1, fontSize: 13, color: theme.colors.foreground }}>
                    {resource.displayName}
                  </Text>
                  <Text style={muted}>{[resource.type, resource.health ?? resource.state].filter(Boolean).join(" · ")}</Text>
                  <View style={{ flex: 1 }} />
                  {resource.dashboardUrl ? <Link theme={theme} label="Details" url={resource.dashboardUrl} onOpen={open} /> : null}
                </View>
                {resource.urls.map((url) => (
                  <View key={url.url} style={{ paddingLeft: 14 }}>
                    <Link theme={theme} label={displayUrl(url.url)} url={url.url} onOpen={open} />
                  </View>
                ))}
              </View>
            ))}
          </>
        ) : null}

        {openError ? <Text style={{ fontSize: 12, color: theme.colors.statusDanger }}>{openError}</Text> : null}
      </View>
    );
  };
}
