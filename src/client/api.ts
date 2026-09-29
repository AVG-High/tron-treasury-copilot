export async function api<T>(
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers:
      body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(45_000)])
      : AbortSignal.timeout(45_000),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(
      typeof data.error === "string"
        ? data.error
        : "Unable to process the request. Please try again shortly.",
    );
  return data as T;
}
