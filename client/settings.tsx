import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { useSettings, type PluginSurfaceProps } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsInput,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { defaultLoomSettings, loomSettings, type LoomSettings } from "../shared/settings.ts";

function emptyDraft(): LoomSettings {
  return {
    ...defaultLoomSettings,
    environmentKeys: { ...defaultLoomSettings.environmentKeys },
  };
}

export default function LoomSettingsScreen({ theme, layout }: PluginSurfaceProps) {
  const settings = useSettings(loomSettings);
  const [draft, setDraft] = useState<LoomSettings>(emptyDraft);
  const [revision, setRevision] = useState<string | null>(null);

  useEffect(() => {
    if (settings.status !== "ready") return;
    setDraft(settings.values);
    setRevision(settings.revision);
  }, [settings.status, settings.status === "ready" ? settings.revision : null]);

  if (settings.status === "loading") {
    return <Text style={{ color: theme.colors.foreground }}>Loading settings…</Text>;
  }
  if (settings.status === "error") {
    return <Text style={{ color: theme.colors.foreground }}>Unable to load settings: {settings.error}</Text>;
  }
  if (settings.status === "invalid") {
    return <Text style={{ color: theme.colors.foreground }}>Invalid saved settings: {settings.error}</Text>;
  }

  const update = (changes: Partial<LoomSettings>) => {
    setDraft((current) => ({ ...current, ...changes }));
  };
  const updateEnvironmentKey = (
    key: keyof LoomSettings["environmentKeys"],
    value: string,
  ) => {
    setDraft((current) => ({
      ...current,
      environmentKeys: { ...current.environmentKeys, [key]: value },
    }));
  };
  const save = async () => {
    if (!revision) return;
    const saved = await settings.save(draft, revision);
    if (saved) await settings.reload();
  };
  const inputHint = "留空时使用对应的环境变量";
  const keyHint = "合法的环境变量名，例如 PASEO_LOOM_PROMPT";

  return (
    <>
      <SettingsSection title="Agent 配置">
        <SettingsCard>
          <SettingsInput
            key={`provider-${revision}`}
            label="Provider"
            hint={inputHint}
            initialValue={draft.provider}
            onChangeText={(provider) => update({ provider })}
          />
          <SettingsInput
            key={`model-${revision}`}
            label="Model"
            hint={inputHint}
            initialValue={draft.model}
            onChangeText={(model) => update({ model })}
          />
          <SettingsInput
            key={`mode-id-${revision}`}
            label="Mode ID"
            hint={inputHint}
            initialValue={draft.modeId}
            onChangeText={(modeId) => update({ modeId })}
          />
          <SettingsRow label="Prompt" hint={inputHint}>
            <TextInput
              key={`prompt-${revision}`}
              multiline
              numberOfLines={8}
              value={draft.prompt}
              onChangeText={(prompt) => update({ prompt })}
              placeholder="留空时使用环境变量"
              placeholderTextColor={theme.colors.foregroundMuted}
              style={{
                minHeight: layout.compact ? 120 : 160,
                color: theme.colors.foreground,
                borderColor: theme.colors.border,
                borderWidth: 1,
                borderRadius: 8,
                padding: 10,
                textAlignVertical: "top",
              }}
            />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="环境变量兜底">
        <SettingsCard>
          <SettingsSwitch
            label="启用环境变量兜底"
            hint="Settings 中对应字段为空时读取环境变量"
            value={draft.useEnvironmentFallback}
            onValueChange={(useEnvironmentFallback) => update({ useEnvironmentFallback })}
          />
          <SettingsInput
            key={`environment-provider-${revision}`}
            label="Provider 环境变量"
            hint={keyHint}
            initialValue={draft.environmentKeys.provider}
            onChangeText={(provider) => updateEnvironmentKey("provider", provider)}
          />
          <SettingsInput
            key={`environment-model-${revision}`}
            label="Model 环境变量"
            hint={keyHint}
            initialValue={draft.environmentKeys.model}
            onChangeText={(model) => updateEnvironmentKey("model", model)}
          />
          <SettingsInput
            key={`environment-mode-id-${revision}`}
            label="Mode ID 环境变量"
            hint={keyHint}
            initialValue={draft.environmentKeys.modeId}
            onChangeText={(modeId) => updateEnvironmentKey("modeId", modeId)}
          />
          <SettingsInput
            key={`environment-prompt-${revision}`}
            label="Prompt 环境变量"
            hint={keyHint}
            initialValue={draft.environmentKeys.prompt}
            onChangeText={(prompt) => updateEnvironmentKey("prompt", prompt)}
          />
        </SettingsCard>
      </SettingsSection>

      <SettingsSection title="保存">
        <SettingsCard>
          <SettingsAction
            label="保存配置"
            actionLabel={settings.saving ? "保存中…" : "保存"}
            disabled={settings.saving || !revision}
            error={settings.saveError}
            onPress={() => void save()}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
