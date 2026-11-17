// A slow report, cut off after three seconds by its own timer.
export async function slowReport(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 3000);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}
