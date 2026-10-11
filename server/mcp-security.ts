// Keep authentication out of tool content, errors and launcher metadata.
export const factorySecrets = () => Object.entries(process.env).filter(([key, value]) => key.toUpperCase() === "FACTORY_TOKEN" && value).map(([, value]) => value!);

export function redactText(text: string, secrets: readonly (string | undefined)[]) {
  let safe = text;
  for (const secret of secrets.filter((x): x is string => !!x).sort((a, b) => b.length - a.length)) {
    safe = safe.split(secret).join("[redacted]");
    const encoded = JSON.stringify(secret).slice(1, -1);
    if (encoded !== secret) safe = safe.split(encoded).join("[redacted]");
  }
  return safe;
}

export function redactValue<T>(value: T, secrets: readonly (string | undefined)[]): T {
  if (typeof value === "string") return redactText(value, secrets) as T;
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [redactText(key, secrets), redactValue(item, secrets)])) as T;
  return value;
}

export function launcherEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([key]) => !key.toUpperCase().startsWith("FACTORY_") && !key.toUpperCase().startsWith("EASY_WORKFLOW_") && !["H2_STATION_CONNECTION", "PI_CODING_AGENT_DIR"].includes(key.toUpperCase())));
}
