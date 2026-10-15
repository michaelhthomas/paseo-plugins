import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, TextInput } from "@getpaseo/plugin/client/react-native";
import { useRef } from "react";
import type { NativeSyntheticEvent, TextInputKeyPressEventData, View as NativeView } from "react-native";
import { ActivityIndicator, Platform, Pressable, Text, View } from "react-native";
import type { GitStatus } from "../shared/git";
import { useRepoActions } from "./actions";
import { IconButton } from "./controls";
import type { MenuEntry } from "./menu";
import { useRepo, type CommitMode, type RepoStore } from "./repo-store";
import { terminalFont } from "./terminal-font";

const COLLAPSED_HEIGHT = 150;

const MODES: { mode: CommitMode; label: string; description: string }[] = [
  { mode: "staged", label: "Commit", description: "Commit staged changes" },
  { mode: "all", label: "Commit All", description: "Stage every change, then commit" },
  { mode: "amend", label: "Amend Last Commit", description: "Add staged changes to the last commit" },
];

function blockedReason(status: GitStatus, mode: CommitMode, message: string) {
  if (status.conflicted.length > 0) return "Resolve merge conflicts first";
  if (!message.trim()) return "Enter a commit message";
  if (mode === "staged" && status.staged.length === 0) return "Stage changes to commit";
  if (mode === "all" && status.staged.length + status.unstaged.length === 0) return "Nothing to commit";
  return null;
}

/** The commit message editor with its Commit split button. `expanded` makes it fill the panel. */
export function CommitBox({
  store,
  workspaceId,
  theme,
  status,
  expanded,
  onToggleExpanded,
  openMenu,
}: {
  store: RepoStore;
  workspaceId: string;
  theme: PluginTheme;
  status: GitStatus;
  expanded: boolean;
  onToggleExpanded(): void;
  /** Opens the panel's menu below `button`. */
  openMenu(button: NativeView | null, entries: MenuEntry[]): void;
}) {
  const { state } = useRepo(store, workspaceId);
  const actions = useRepoActions(store, workspaceId);
  const modeButton = useRef<NativeView>(null);
  const { message, mode } = state.draft;
  const blocked = blockedReason(status, mode, message);
  const current = MODES.find((option) => option.mode === mode) ?? MODES[0];

  const commit = () => {
    if (!blocked && !state.committing) void actions.commit();
  };

  const selectMode = async (next: CommitMode) => {
    store.setDraft(workspaceId, { mode: next });
    if (next === "amend" && !message.trim()) {
      const last = await store.lastCommitMessage(workspaceId);
      // Only fill in if nothing was typed meanwhile.
      if (last && !store.get(workspaceId).draft.message.trim()) store.setDraft(workspaceId, { message: last });
    }
  };

  const onKeyPress = (event: NativeSyntheticEvent<TextInputKeyPressEventData>) => {
    const native = event.nativeEvent as TextInputKeyPressEventData & { ctrlKey?: boolean; metaKey?: boolean };
    if (Platform.OS === "web" && native.key === "Enter" && (native.ctrlKey || native.metaKey)) {
      event.preventDefault();
      commit();
    }
  };

  const disabled = blocked !== null || state.committing;
  const buttonColor = disabled ? theme.colors.foregroundMuted : theme.colors.foreground;
  return (
    <View
      style={{
        margin: 8,
        ...(expanded ? { flex: 1 } : { height: COLLAPSED_HEIGHT }),
        borderWidth: 1,
        borderColor: theme.colors.border,
        borderRadius: 8,
        backgroundColor: theme.colors.surface1,
      }}
    >
      <TextInput
        accessibilityLabel="Commit message"
        multiline
        value={message}
        onChangeText={(text) => store.setDraft(workspaceId, { message: text })}
        onKeyPress={onKeyPress}
        placeholder={mode === "amend" ? "Amended commit message" : "Enter commit message"}
        placeholderTextColor={theme.colors.foregroundMuted}
        style={[
          terminalFont,
          {
            flex: 1,
            paddingLeft: 12,
            paddingRight: 40,
            paddingTop: 10,
            paddingBottom: 4,
            color: theme.colors.foreground,
            textAlignVertical: "top",
            // No focus ring on web; the box's border is the field.
            ...(Platform.OS === "web" ? ({ outlineStyle: "none" } as object) : {}),
          },
        ]}
      />
      <View style={{ position: "absolute", top: 6, right: 6 }}>
        <IconButton
          theme={theme}
          icon={expanded ? "Minimize2" : "Maximize2"}
          size={14}
          label={expanded ? "Shrink the commit message box" : "Expand the commit message box"}
          onPress={onToggleExpanded}
        />
      </View>
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "flex-end", padding: 6 }}>
        <View style={{ flexDirection: "row", borderRadius: 5, backgroundColor: theme.colors.surface2, opacity: disabled ? 0.7 : 1 }}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={current.description}
            accessibilityHint={blocked ?? undefined}
            accessibilityState={{ disabled, busy: state.committing }}
            disabled={disabled}
            onPress={commit}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              gap: 4,
              paddingHorizontal: 8,
              height: 22,
              borderTopLeftRadius: 5,
              borderBottomLeftRadius: 5,
              backgroundColor: pressed ? theme.colors.border : "transparent",
            })}
          >
            {state.committing ? <ActivityIndicator size="small" color={theme.colors.foregroundMuted} /> : null}
            <Text style={{ fontSize: 12, fontWeight: "500", color: buttonColor }}>{current.mode === "amend" ? "Amend" : current.label}</Text>
          </Pressable>
          <View style={{ width: 1, marginVertical: 4, backgroundColor: theme.colors.border }} />
          <Pressable
            accessibilityRole="button"
            ref={modeButton}
            accessibilityLabel="Choose how to commit"
            onPress={() =>
              openMenu(
                modeButton.current,
                MODES.map((option) => ({
                  kind: "item" as const,
                  label: option.label,
                  checked: option.mode === mode,
                  onSelect: () => void selectMode(option.mode),
                })),
              )
            }
            style={({ pressed }) => ({
              width: 18,
              height: 22,
              alignItems: "center",
              justifyContent: "center",
              borderTopRightRadius: 5,
              borderBottomRightRadius: 5,
              backgroundColor: pressed ? theme.colors.border : "transparent",
            })}
          >
            <Icon name="ChevronDown" size={12} color={theme.colors.foreground} />
          </Pressable>
        </View>
      </View>
    </View>
  );
}
