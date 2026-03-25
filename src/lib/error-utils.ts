export function getErrorMessage(payload: unknown, fallback: string) {
  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    if (typeof record.error === "string") {
      return record.error;
    }
    if (record.error && typeof record.error === "object" && typeof (record.error as Record<string, unknown>).message === "string") {
      return (record.error as Record<string, unknown>).message as string;
    }
    if (typeof record.message === "string") {
      return record.message;
    }
  }
  return fallback;
}
