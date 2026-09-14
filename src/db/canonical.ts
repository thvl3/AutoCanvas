import { createHash } from "node:crypto";

// Remove only known authentication/expiry parameters; resource selectors remain meaningful.
const VOLATILE_QUERY =
  /^(x-amz-.+|x-goog-.+|signature|sig|expires|expiry|token|access_token|verifier|policy|key-pair-id|awsaccesskeyid)$/i;
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, entry]) => [key, canonicalize(entry)]),
    );
  }
  if (typeof value === "string" && /^https?:\/\//i.test(value)) {
    try {
      const url = new URL(value);
      for (const key of [...url.searchParams.keys()])
        if (VOLATILE_QUERY.test(key)) url.searchParams.delete(key);
      url.searchParams.sort();
      return url.toString();
    } catch {
      /* Non-URL text remains literal. */
    }
  }
  return value;
}
export function hash(value: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonicalize(value)) ?? "undefined")
    .digest("hex");
}
export function changedFields(
  old: unknown,
  fresh: unknown,
  prefix = "",
): string[] {
  if (hash(old) === hash(fresh)) return [];
  if (
    old &&
    fresh &&
    typeof old === "object" &&
    typeof fresh === "object" &&
    !Array.isArray(old) &&
    !Array.isArray(fresh)
  ) {
    const a = old as Record<string, unknown>;
    const b = fresh as Record<string, unknown>;
    return [...new Set([...Object.keys(a), ...Object.keys(b)])]
      .sort()
      .flatMap((key) =>
        changedFields(a[key], b[key], prefix ? `${prefix}.${key}` : key),
      );
  }
  return [prefix];
}
