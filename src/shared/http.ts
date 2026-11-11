/** fetch with pacing + exponential backoff on 429/5xx (public indexers rate-limit hard). */
let last = 0;
export async function fetchRetry(url: string, init: RequestInit = {}, opts: { attempts?: number; minGapMs?: number; timeoutMs?: number } = {}): Promise<Response> {
  const attempts = opts.attempts ?? 7;
  for (let i = 0; ; i++) {
    const gap = (opts.minGapMs ?? 250) - (Date.now() - last);
    if (gap > 0) await new Promise((r) => setTimeout(r, gap));
    last = Date.now();
    let res: Response | undefined;
    try {
      res = await fetch(url, { ...init, signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000) });
    } catch (e) {
      if (i >= attempts - 1) throw e;
    }
    if (res && res.status !== 429 && res.status < 500) return res;
    if (i >= attempts - 1) return res!;
    const retryAfter = Number(res?.headers.get("retry-after") ?? 0) * 1000;
    await new Promise((r) => setTimeout(r, Math.max(retryAfter, 500 * 2 ** i)));
  }
}
