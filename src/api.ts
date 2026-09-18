export class ApiError extends Error {
  constructor(message: string, public status: number, public details: Record<string, unknown>) {
    super(message);
    this.name = "ApiError";
  }
}
export async function api<T = any>(
  path: string,
  options: RequestInit = {},
): Promise<T> {
  let response: Response;
  try { response = await fetch("/api" + path, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-Fieldhouse-Request": "1",
      ...options.headers,
    },
  });
  } catch (error) {
    if (options.signal?.aborted) throw error;
    throw new ApiError("Could not connect to the server. Check your connection. If you were saving a change, check its result before submitting again.", 0, {});
  }
  let value: unknown;
  try { value = await response.json(); }
  catch {
    throw new ApiError("The server returned an unreadable response. If you were saving a change, check its result before submitting again.", response.status, {});
  }
  if (!response.ok) {
    const details = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
    throw new ApiError(typeof details.error === "string" ? details.error : `Request failed (${response.status}).`, response.status, details);
  }
  return value as T;
}
export const money = (cents: number = 0) =>
  new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    cents / 100,
  );
export const shortDate = (date: string) =>
  date
    ? new Date(
        date.length === 10 ? date + "T12:00:00" : date,
      ).toLocaleDateString("en-US")
    : "—";
export function csvCell(v: unknown) {
    let s = String(v ?? "");
    if (/^[\s\uFEFF]*[=+@-]|^[\t\r\n]/.test(s)) s = "'" + s;
    return '"' + s.replaceAll('"', '""') + '"';
}
export function csv(name: string, headers: string[], rows: unknown[][]) {
  const url = URL.createObjectURL(
    new Blob(
      [[headers, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n")],
      { type: "text/csv;charset=utf-8;" },
    ),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = name + ".csv";
  a.click();
  URL.revokeObjectURL(url);
}
