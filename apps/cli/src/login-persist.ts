import type { AuthSessionStatus } from "./auth.js";
import { defaultUserConfigPath, persistUserProviderDefaults } from "./config.js";

/** Write provider/model/base_url from a successful `/login` into the user config.toml. */
export async function persistLoginProviderDefaults(
  status: AuthSessionStatus,
  configPath = defaultUserConfigPath(),
  extras?: {
    readonly outputReserveTokens?: number;
  },
): Promise<string> {
  const saved = await persistUserProviderDefaults(
    {
      provider: status.provider,
      model: status.model,
      accountAlias: status.accountAlias,
      ...(status.baseURL === undefined ? {} : { baseURL: status.baseURL }),
      ...(status.reasoningEffort === undefined
        ? {}
        : { reasoningEffort: status.reasoningEffort }),
      ...(status.contextWindowTokensOverride
        ? { contextWindowTokens: status.contextWindowTokens }
        : {}),
      ...(extras?.outputReserveTokens === undefined
        ? {}
        : { outputReserveTokens: extras.outputReserveTokens }),
      imageInput: status.imageInput,
    },
    configPath,
  );
  return saved.path;
}
