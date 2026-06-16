/**
 * Stricter redaction than the bot's internal redactConfigValue — the dashboard
 * is an HTTP boundary, so anything that looks remotely like a secret is masked.
 */
const SENSITIVE_KEY_PATTERNS = [
  /key$/i,
  /secret/i,
  /token$/i,
  /mnemonic/i,
  /password/i,
  /privateKey/i,
  /private_key/i,
  /seed$/i,
];

const SENSITIVE_KEY_EXACT = new Set([
  "rpcUrl", // typically contains an embedded API key (?api-key=…)
  "walletKey",
  "WALLET_PRIVATE_KEY",
  "PRIVATE_KEY",
]);

export function isSensitiveKey(key) {
  if (SENSITIVE_KEY_EXACT.has(key)) return true;
  return SENSITIVE_KEY_PATTERNS.some((p) => p.test(key));
}

export function redactValue(key, value) {
  if (!isSensitiveKey(key)) return value;
  if (value == null || value === "") return value;
  if (typeof value !== "string") return "***redacted***";
  // Preserve a short hint so the operator can see something is set
  if (value.length <= 8) return "***redacted***";
  return `${value.slice(0, 4)}…***`;
}

export function redactObject(obj) {
  if (obj == null || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redactObject);
  return Object.fromEntries(
    Object.entries(obj).map(([k, v]) => [k, isSensitiveKey(k) ? redactValue(k, v) : redactObject(v)]),
  );
}
