import type { PluginClientContext } from "@getpaseo/plugin/client";
import LoomSettingsScreen from "./client/settings";

export default function contribute(client: PluginClientContext) {
  return client.addSettingsScreen({
    id: "configuration",
    title: "paseo-loom 配置",
    icon: "Settings2",
    Component: LoomSettingsScreen,
  });
}
