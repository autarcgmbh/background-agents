/**
 * Grafana Agent Observability tags for the provider account a session runs on.
 *
 * The agento11y plugins take custom attributes only through AGENTO11Y_TAGS, a
 * comma-separated list of key=value pairs split on the first "=", where the
 * last duplicate key wins. The account tags go first so a tag the operator
 * set explicitly in Settings → Secrets still wins, the same rule the runtime
 * applies to its repo tag.
 */

const PROVIDER_ACCOUNT_TAG = "provider_account";
const PROVIDER_ACCOUNT_ID_TAG = "provider_account_id";

export interface ObservedProviderAccount {
  id: string;
  displayName: string;
}

/** Keep a display name inside the tag grammar: no separators, no control characters. */
export function sanitizeTagValue(value: string, fallback: string): string {
  const cleaned = value
    .replace(/[,=\p{Cc}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

export function composeProviderAccountTags(
  existing: string | undefined,
  account: ObservedProviderAccount
): string {
  const tags = [
    `${PROVIDER_ACCOUNT_TAG}=${sanitizeTagValue(account.displayName, account.id)}`,
    `${PROVIDER_ACCOUNT_ID_TAG}=${account.id}`,
  ];
  const rest = existing?.trim();
  if (rest) tags.push(rest);
  return tags.join(",");
}
