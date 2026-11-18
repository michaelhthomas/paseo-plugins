import { useRpc, useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSelect,
} from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Text } from "react-native";
import { EMPTY_CONFIG, listProjectsRpc, projectSettings, type ProjectConfig, type ProjectSummary } from "../shared/contracts";

export function WorkRefsSettings({ theme }: PluginSurfaceProps) {
  const settings = useSettings(projectSettings);
  const listProjects = useRpc(listProjectsRpc);
  const projects = useQuery({ queryKey: ["work-refs-projects"], queryFn: () => listProjects({}) });
  const [selected, setSelected] = useState<string | null>(null);

  if (settings.status === "loading" || projects.isPending) return null;
  if (settings.status === "error") return <Text style={{ color: theme.colors.statusDanger }}>{settings.error}</Text>;
  if (settings.status === "invalid") {
    return (
      <SettingsSection title="Projects">
        <SettingsCard>
          <SettingsRow label="Settings could not be read" error={settings.error} />
          <SettingsAction label="Reset all projects" actionLabel="Reset" onPress={() => void settings.reset()} />
        </SettingsCard>
      </SettingsSection>
    );
  }
  if (projects.isError) {
    return (
      <SettingsSection title="Projects">
        <SettingsCard>
          <SettingsAction
            label="Projects could not be listed"
            error={projects.error instanceof Error ? projects.error.message : String(projects.error)}
            actionLabel="Retry"
            onPress={() => void projects.refetch()}
          />
        </SettingsCard>
      </SettingsSection>
    );
  }

  const list = projects.data.projects;
  const project = list.find((candidate) => candidate.id === selected) ?? list[0];
  if (!project) {
    return (
      <SettingsSection title="Projects">
        <SettingsCard>
          <SettingsRow label="No projects" hint="Add a project to Paseo to set its GitHub repo and Azure DevOps project." />
        </SettingsCard>
      </SettingsSection>
    );
  }

  return (
    <>
      <SettingsSection title="Project">
        <SettingsCard>
          <SettingsSelect
            label="Project"
            hint="References in this project's agent replies use these settings."
            value={project.id}
            options={list.map((candidate) => ({ label: candidate.name, value: candidate.id }))}
            onValueChange={setSelected}
          />
        </SettingsCard>
      </SettingsSection>
      <ProjectEditor
        key={project.id}
        project={project}
        saved={settings.values.projects[project.id] ?? EMPTY_CONFIG}
        saving={settings.saving}
        saveError={settings.saveError}
        onSave={(config) => {
          const next = { ...settings.values.projects };
          if (config.githubRepo || config.adoOrganization || config.adoProject) next[project.id] = config;
          else delete next[project.id];
          return settings.save({ ...settings.values, projects: next }, settings.revision);
        }}
      />
    </>
  );
}

function ProjectEditor({
  project,
  saved,
  saving,
  saveError,
  onSave,
}: {
  project: ProjectSummary;
  saved: ProjectConfig;
  saving: boolean;
  saveError: string | null;
  onSave: (config: ProjectConfig) => Promise<boolean>;
}) {
  const { detected } = project;
  const [draft, setDraft] = useState<ProjectConfig>(saved);
  const [savedOnce, setSavedOnce] = useState(false);
  const dirty =
    draft.githubRepo.trim() !== saved.githubRepo ||
    draft.adoOrganization.trim() !== saved.adoOrganization ||
    draft.adoProject.trim() !== saved.adoProject;

  const placeholder = (value: string, fallback: string) => (value ? `${value} (from origin)` : fallback);
  const update = (field: keyof ProjectConfig) => (text: string) => {
    setSavedOnce(false);
    setDraft((current) => ({ ...current, [field]: text }));
  };

  return (
    <>
      <SettingsSection title="GitHub">
        <SettingsCard>
          <SettingsInput
            label="Default repository"
            hint="#123 links to this repository's issue or pull request."
            initialValue={saved.githubRepo}
            placeholder={placeholder(detected.githubRepo, "owner/repo")}
            onChangeText={update("githubRepo")}
            disabled={saving}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Azure Boards">
        <SettingsCard>
          <SettingsInput
            label="Organization"
            hint="The name in dev.azure.com/<organization>."
            initialValue={saved.adoOrganization}
            placeholder={placeholder(detected.adoOrganization, "contoso")}
            onChangeText={update("adoOrganization")}
            disabled={saving}
          />
          <SettingsInput
            label="Project"
            hint="AB#123 links to this project's work item."
            initialValue={saved.adoProject}
            placeholder={placeholder(detected.adoProject, "Project name")}
            onChangeText={update("adoProject")}
            disabled={saving}
          />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Save">
        <SettingsCard>
          <SettingsAction
            label={savedOnce && !dirty ? "Saved" : "Save changes"}
            hint="Empty fields use the project's origin remote. Tokens come from the GitHub CLI (gh) and Azure CLI (az) on the host."
            error={saveError}
            actionLabel="Save"
            disabled={saving || !dirty}
            onPress={() => {
              const config = {
                githubRepo: draft.githubRepo.trim(),
                adoOrganization: draft.adoOrganization.trim(),
                adoProject: draft.adoProject.trim(),
              };
              void onSave(config).then((ok) => setSavedOnce(ok));
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
