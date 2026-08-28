export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function errorMessage(payload: unknown, fallback: string): string {
  if (!payload) return fallback;
  if (typeof payload === "string") return payload;
  if (!isRecord(payload)) return fallback;

  const detail = payload.detail ?? payload.message ?? payload.error;
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((item) => {
        if (!isRecord(item)) return String(item);
        return String(item.msg ?? item.message ?? item);
      })
      .join("；");
  }
  return fallback;
}
