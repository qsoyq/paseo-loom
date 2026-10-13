import { useEffect, useState } from "react";
import { Text, TextInput } from "react-native";
import { useSettings, type PluginSurfaceProps, type SettingsState } from "@getpaseo/plugin/client";
import {
  SettingsAction,
  SettingsCard,
  SettingsRow,
  SettingsSection,
  SettingsSwitch,
} from "@getpaseo/plugin/client/ui";
import { loomSettings, type LoomSettings } from "../shared/settings.ts";
import { pluginVersion } from "../shared/version.ts";

type ReadySettings = Extract<SettingsState<typeof loomSettings.schema>, { status: "ready" }>;

export default function LoomSettingsScreen(props: PluginSurfaceProps) {
  const settings = useSettings(loomSettings);
  if (settings.status === "loading") {
    return <Text style={{ color: props.theme.colors.foreground }}>正在读取配置…</Text>;
  }
  if (settings.status === "error" || settings.status === "invalid") {
    return (
      <SettingsSection title="配置读取失败">
        <SettingsCard>
          <SettingsAction
            label={settings.error}
            actionLabel="重新读取"
            onPress={() => void settings.reload()}
          />
          {settings.status === "invalid" && (
            <SettingsAction
              label="恢复默认配置"
              hint="清空已保存的字段，恢复原有环境变量兜底设置。"
              actionLabel="恢复默认"
              disabled={settings.saving}
              error={settings.saveError}
              onPress={() => void settings.reset()}
            />
          )}
        </SettingsCard>
      </SettingsSection>
    );
  }
  return <SettingsEditor key={props.host.id} {...props} settings={settings} />;
}

function SettingsEditor({ theme, layout, settings }: PluginSurfaceProps & { settings: ReadySettings }) {
  const [draft, setDraft] = useState<LoomSettings>(settings.values);
  const [revision, setRevision] = useState(settings.revision);
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState(false);
  const validation = loomSettings.schema.safeParse(draft);
  const changedRemotely = revision !== settings.revision;

  useEffect(() => {
    if (dirty) return;
    setDraft(settings.values);
    setRevision(settings.revision);
  }, [dirty, settings.revision, settings.values]);

  const update = (changes: Partial<LoomSettings>) => {
    setDirty(true);
    setSaved(false);
    setDraft((current) => ({ ...current, ...changes }));
  };
  const updateEnvironmentKey = (key: keyof LoomSettings["environmentKeys"], value: string) => {
    setDirty(true);
    setSaved(false);
    setDraft((current) => ({
      ...current,
      environmentKeys: { ...current.environmentKeys, [key]: value },
    }));
  };
  const save = async () => {
    if (settings.saving || !validation.success) return;
    if (await settings.save(draft, revision)) {
      setDirty(false);
      setSaved(true);
    }
  };
  const fields = [
    ["provider", "Provider"], ["model", "Model"], ["modeId", "Mode ID"], ["prompt", "Prompt"],
  ] as const;
  const inputStyle = {
    color: theme.colors.foreground,
    borderColor: theme.colors.border,
    borderWidth: 1,
    borderRadius: 8,
    padding: 10,
  };

  return (
    <>
      <SettingsSection title="关于">
        <SettingsCard>
          <SettingsRow label="paseo-loom" hint={`版本 ${pluginVersion}`} />
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="Agent 配置">
        <SettingsCard>
          {fields.map(([key, label]) => (
            <SettingsRow
              key={key}
              label={label}
              hint={draft.useEnvironmentFallback
                ? "留空时使用对应的环境变量。"
                : "环境变量兜底已关闭，请填写此项。"}
            >
              <TextInput
                accessibilityLabel={label}
                value={draft[key]}
                editable={!settings.saving}
                multiline={key === "prompt"}
                autoCorrect={false}
                autoCapitalize="none"
                onChangeText={(value) => update({ [key]: value })}
                style={[inputStyle, key === "prompt" && {
                  minHeight: layout.compact ? 120 : 160,
                  textAlignVertical: "top",
                }]}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="环境变量兜底">
        <SettingsCard>
          <SettingsSwitch
            label="启用环境变量兜底"
            hint="默认开启，兼容原有四个环境变量。只读取插件进程继承的环境。"
            value={draft.useEnvironmentFallback}
            disabled={settings.saving}
            onValueChange={(useEnvironmentFallback) => update({ useEnvironmentFallback })}
          />
          {fields.map(([key, label]) => (
            <SettingsRow key={key} label={`${label} 环境变量`} hint="填写合法的 shell 变量名。">
              <TextInput
                accessibilityLabel={`${label} 环境变量`}
                value={draft.environmentKeys[key]}
                editable={!settings.saving}
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(value) => updateEnvironmentKey(key, value)}
                style={inputStyle}
              />
            </SettingsRow>
          ))}
        </SettingsCard>
      </SettingsSection>
      <SettingsSection title="保存">
        <SettingsCard>
          <SettingsAction
            label={saved ? "配置已保存" : "保存配置"}
            hint={changedRemotely && dirty
              ? "其他客户端已更新配置。草稿已保留；保存时会检查冲突。"
              : "保存后对新 workspace 生效，无需重载插件。"}
            actionLabel={settings.saving ? "保存中…" : "保存"}
            disabled={settings.saving || !dirty || !validation.success}
            error={settings.saveError ?? (validation.success ? null : "环境变量名称必须是合法的 shell 变量名。")}
            onPress={() => void save()}
          />
          <SettingsAction
            label="放弃草稿并读取最新配置"
            actionLabel="读取最新"
            disabled={settings.saving}
            onPress={() => {
              setDraft(settings.values);
              setRevision(settings.revision);
              setDirty(false);
              setSaved(false);
              void settings.reload();
            }}
          />
        </SettingsCard>
      </SettingsSection>
    </>
  );
}
