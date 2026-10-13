import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const defaultEnvironmentKeys = {
  provider: "PASEO_LOOM_PROVIDER",
  model: "PASEO_LOOM_MODEL",
  modeId: "PASEO_LOOM_MODE_ID",
  prompt: "PASEO_LOOM_PROMPT",
} as const;

const environmentKey = z.string().regex(
  /^[A-Za-z_][A-Za-z0-9_]*$/,
  "Environment variable name must be a valid shell variable name",
);

export const loomSettings = defineSettings({
  id: "configuration",
  scope: "host",
  version: 1,
  schema: z.object({
    provider: z.string().default(""),
    model: z.string().default(""),
    modeId: z.string().default(""),
    prompt: z.string().default(""),
    useEnvironmentFallback: z.boolean().default(true),
    environmentKeys: z.object({
      provider: environmentKey.default(defaultEnvironmentKeys.provider),
      model: environmentKey.default(defaultEnvironmentKeys.model),
      modeId: environmentKey.default(defaultEnvironmentKeys.modeId),
      prompt: environmentKey.default(defaultEnvironmentKeys.prompt),
    }).default(defaultEnvironmentKeys),
  }),
});

export type LoomSettings = z.output<typeof loomSettings.schema>;

export const defaultLoomSettings: LoomSettings = {
  provider: "",
  model: "",
  modeId: "",
  prompt: "",
  useEnvironmentFallback: true,
  environmentKeys: { ...defaultEnvironmentKeys },
};
