// Helpers for calling other services.
export async function fetchJson(url, options = {}) {
  const res = await fetch(url, { ...options, headers: { accept: 'application/json', ...options.headers } });
  if (!res.ok) throw new Error(`upstream answered ${res.status}`);
  return res.json();
}

export async function fetchWithDeadline(url, ms = 2000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(ms) });
  return res.json();
}
