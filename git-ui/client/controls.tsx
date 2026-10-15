import type { PluginTheme } from "@getpaseo/plugin";
import { Icon, Modal } from "@getpaseo/plugin/client/react-native";
import { useCallback, useState, type ReactNode, type Ref } from "react";
import type { View as NativeView } from "react-native";
import { Pressable, Text, View } from "react-native";

export function IconButton({
  theme,
  icon,
  label,
  onPress,
  disabled,
  color,
  size = 15,
  ref,
}: {
  theme: PluginTheme;
  icon: string;
  label: string;
  onPress(): void;
  disabled?: boolean;
  color?: string;
  size?: number;
  ref?: Ref<NativeView>;
}) {
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      hitSlop={4}
      onPress={onPress}
      style={({ pressed, hovered }: { pressed: boolean; hovered?: boolean }) => ({
        width: size + 11,
        height: size + 11,
        borderRadius: 6,
        alignItems: "center",
        justifyContent: "center",
        opacity: disabled ? 0.4 : 1,
        backgroundColor: pressed ? theme.colors.surface2 : hovered ? theme.colors.surface1 : "transparent",
      })}
    >
      <Icon name={icon} size={size} color={color ?? theme.colors.foregroundMuted} />
    </Pressable>
  );
}

export function TextButton({
  theme,
  label,
  onPress,
  disabled,
  primary,
  danger,
  icon,
}: {
  theme: PluginTheme;
  label: string;
  onPress(): void;
  disabled?: boolean;
  primary?: boolean;
  danger?: boolean;
  icon?: string;
}) {
  const filled = primary || danger;
  const background = danger ? theme.colors.statusDanger : primary ? theme.colors.accent : theme.colors.surface2;
  const foreground = filled ? theme.colors.accentForeground : theme.colors.foreground;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        justifyContent: "center",
        gap: 6,
        paddingHorizontal: 12,
        paddingVertical: 7,
        borderRadius: 7,
        backgroundColor: background,
        opacity: disabled ? 0.45 : pressed ? 0.8 : 1,
      })}
    >
      {icon ? <Icon name={icon} size={14} color={foreground} /> : null}
      <Text style={{ color: foreground, fontSize: 13, fontWeight: "600" }}>{label}</Text>
    </Pressable>
  );
}

type ConfirmRequest = { title: string; message: string; action: string; onConfirm(): void };

/** A confirmation modal for destructive actions. Render `element` once; call `confirm` to open it. */
export function useConfirm(theme: PluginTheme): { confirm(request: ConfirmRequest): void; element: ReactNode } {
  const [request, setRequest] = useState<ConfirmRequest | null>(null);
  const confirm = useCallback((next: ConfirmRequest) => setRequest(next), []);
  const close = () => setRequest(null);
  const element = (
    <Modal
      title={request?.title ?? ""}
      icon={<Icon name="TriangleAlert" size={18} color={theme.colors.statusDanger} />}
      open={request !== null}
      onOpenChange={(open) => !open && close()}
    >
      <Modal.Content>
        <Text style={{ color: theme.colors.foreground, fontSize: 14, lineHeight: 20 }}>{request?.message}</Text>
        <View style={{ flexDirection: "row", justifyContent: "flex-end", gap: 8 }}>
          <TextButton theme={theme} label="Cancel" onPress={close} />
          <TextButton
            theme={theme}
            danger
            label={request?.action ?? "Discard"}
            onPress={() => {
              request?.onConfirm();
              close();
            }}
          />
        </View>
      </Modal.Content>
    </Modal>
  );
  return { confirm, element };
}
