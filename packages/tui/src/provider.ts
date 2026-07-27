/**
 * Format a provider identity for a terminal surface without importing provider
 * authentication, environment, or transport configuration.
 */
export function formatProviderLabel(provider: string, accountAlias?: string): string {
  if (provider === "compatible" && accountAlias && accountAlias !== "default") {
    return accountAlias;
  }
  return provider;
}
