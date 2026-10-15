import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { useSettings } from "@getpaseo/plugin/client";
import { SettingsCard, SettingsRow, SettingsSection, SettingsSelect, SettingsSwitch } from "@getpaseo/plugin/client/ui";
import { Platform, Text } from "react-native";
import { displaySettings, MATCH_PASEO, SYNTAX_THEMES } from "../shared/git";
import { readPaseoSyntaxTheme } from "./syntax-theme";

const OPTIONS = [{ label: "Match Paseo", value: MATCH_PASEO }, ...SYNTAX_THEMES.map(({ id, label }) => ({ label, value: id }))];

export function GitUiSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(displaySettings);
  if (settings.status === "loading") return null;
  if (settings.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Diff">
        <SettingsCard>
          <SettingsRow label="Settings could not be read" error={settings.error} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  const matched = readPaseoSyntaxTheme();
  const matchedLabel = SYNTAX_THEMES.find((option) => option.id === matched)?.label;
  const { values, revision } = settings;
  return (
    <>
      <SettingsSection title="Changes panel">
        <SettingsCard>
          <SettingsSelect
            label="View"
            value={values.changesView}
            options={[
              { label: "Tree", value: "tree" },
              { label: "List", value: "list" },
            ]}
            disabled={settings.saving}
            onValueChange={(changesView) => void settings.save({ ...values, changesView }, revision)}
          />
          <SettingsSelect
            label="Group by"
            value={values.changesGroupBy}
            options={[
              { label: "None", value: "none" },
              { label: "Tracked & Untracked", value: "tracked" },
              { label: "Staged & Unstaged", value: "staged" },
            ]}
            disabled={settings.saving}
            onValueChange={(changesGroupBy) => void settings.save({ ...values, changesGroupBy }, revision)}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Diff">
        <SettingsCard>
          <SettingsSelect
            label="Layout"
            value={values.diffLayout}
            options={[
              { label: "Unified", value: "unified" },
              { label: "Split", value: "split" },
            ]}
            disabled={settings.saving}
            onValueChange={(diffLayout) => void settings.save({ ...values, diffLayout }, revision)}
          />
          <SettingsSwitch
            label="Collapse unchanged lines"
            hint="When off, diffs show whole files."
            value={values.collapseUnchanged}
            disabled={settings.saving}
            onValueChange={(collapseUnchanged) => void settings.save({ ...values, collapseUnchanged }, revision)}
          />
          <SettingsSwitch
            label="Hide whitespace"
            hint="Whitespace-only changes don't show. Hunks can't be staged while they're hidden."
            value={values.hideWhitespace}
            disabled={settings.saving}
            onValueChange={(hideWhitespace) => void settings.save({ ...values, hideWhitespace }, revision)}
          />
          {Platform.OS === "web" ? (
            <SettingsSwitch
              label="Wrap long lines"
              hint="When off, long lines scroll sideways."
              value={values.wrapLines}
              disabled={settings.saving}
              onValueChange={(wrapLines) => void settings.save({ ...values, wrapLines }, revision)}
            />
          ) : null}
          <SettingsSelect
            label="Syntax theme"
            hint={
              settings.values.syntaxTheme === MATCH_PASEO
                ? matchedLabel
                  ? `Following Paseo's syntax theme (${matchedLabel}). Matching works on desktop and web; elsewhere the plugin uses One.`
                  : "Paseo's syntax theme can't be read here, so the plugin uses One. Matching works on desktop and web."
                : undefined
            }
            value={settings.values.syntaxTheme}
            options={OPTIONS}
            disabled={settings.saving}
            error={settings.saveError}
            onValueChange={(syntaxTheme) => void settings.save({ ...settings.values, syntaxTheme }, settings.revision)}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
