// Crocc — /api/terminal
// Vercel serverless function. Terminal feed: Montra tokens on Elysium.
// Reads the Montra public API (read-only, no key) server-side and returns
// the desk rows — the page never talks to the Montra API directly, so the
// feed works where client-side fetches to that host are blocked.
//
// Rows keep the desk's columns: coin, vol 1h (USD), mc (USD), 1h %,
// dev (creator's share of supply, from the holders endpoint, or null),
// call (BUY / WATCH / PASS). The 1h move comes from the token's 5-minute
// candles inside the last hour; when a token has too few recent candles
// the move is null and the row shows "—" (a BUY then needs a confirmed
// +5% move, so it can never be given on missing data).

const MONTRA = "https://api.montramarkets.xyz";
const ROW_LIMIT = 24;
const CACHE_MS = 60 * 1000;

let cache = { at: 0, data: null };

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=60, stale-while-revalidate=120");
  res.end(JSON.stringify(obj));
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (res.status === 429) {
      await new Promise((r) => setTimeout(r, 1200));
      const retry = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (!retry.ok) throw new Error("Montra API returned HTTP " + retry.status);
      return retry.json();
    }
    if (!res.ok) throw new Error("Montra API returned HTTP " + res.status);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try {
        out[idx] = await fn(items[idx], idx);
      } catch (e) {
        out[idx] = null;
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return out;
}

function callFor(vol1hUsd, chg1h) {
  if (vol1hUsd >= 100000 && chg1h != null && chg1h >= 5) return "BUY";
  if (vol1hUsd >= 25000 || (chg1h != null && chg1h >= 10)) return "WATCH";
  return "PASS";
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed — use GET." });
  }

  if (cache.data && Date.now() - cache.at < CACHE_MS) {
    return sendJson(res, 200, cache.data);
  }

  let trending = [];
  let fresh = [];
  try {
    const [tJson, nJson] = await Promise.all([
      fetchJson(MONTRA + "/api/tokens?sort=trending&limit=" + ROW_LIMIT),
      fetchJson(MONTRA + "/api/tokens?sort=new&limit=" + ROW_LIMIT),
    ]);
    if (Array.isArray(tJson.tokens)) trending = tJson.tokens;
    if (Array.isArray(nJson.tokens)) fresh = nJson.tokens;
  } catch (e) {
    if (cache.data) return sendJson(res, 200, cache.data);
    return sendJson(res, 502, {
      ok: false,
      error: "Couldn't reach the Montra API from the server. Try again in a moment.",
    });
  }

  // Merge newest + trending, dedupe by address, rank by 1h volume.
  const byAddr = new Map();
  trending.concat(fresh).forEach((t) => {
    if (t && t.address && !byAddr.has(t.address.toLowerCase())) {
      byAddr.set(t.address.toLowerCase(), t);
    }
  });
  const tokens = Array.from(byAddr.values())
    .map((t) => ({
      address: t.address,
      symbol: t.symbol || "?",
      vol1hUsd: num(t.volume1hUsd) || 0,
      mcUsd: num(t.marketCapUsd),
      change24hPct: num(t.change24hPct),
      traders1h: typeof t.traders1h === "number" ? t.traders1h : null,
      swaps: typeof t.swaps === "number" ? t.swaps : null,
      launchedAt: typeof t.launchedAt === "number" ? t.launchedAt : null,
    }))
    .sort((a, b) => b.vol1hUsd - a.vol1hUsd)
    .slice(0, ROW_LIMIT);

  // Per token: 1h move from 5-minute candles + creator share from holders.
  const hourAgo = Date.now() - 3600 * 1000;
  const enriched = await mapLimit(tokens, 8, async (t) => {
    let chg1h = null;
    let dev = null;
    try {
      const cJson = await fetchJson(
        MONTRA + "/api/tokens/" + t.address + "/candles?interval=5m&limit=13"
      );
      const candles = Array.isArray(cJson.candles) ? cJson.candles : [];
      const recent = candles.filter(
        (c) => typeof c.t === "number" && c.t >= hourAgo
      );
      if (recent.length >= 2) {
        const open = num(recent[0].open);
        const close = num(recent[recent.length - 1].close);
        if (open && close) chg1h = ((close - open) / open) * 100;
      }
    } catch (e) {
      chg1h = null;
    }
    try {
      const hJson = await fetchJson(
        MONTRA + "/api/tokens/" + t.address + "/holders?limit=1"
      );
      if (typeof hJson.creatorPct === "number") dev = hJson.creatorPct;
    } catch (e) {
      dev = null;
    }
    return {
      coin: t.symbol,
      address: t.address,
      poolName: t.symbol + " / HYPE",
      dex: "montra",
      vol1h: t.vol1hUsd,
      mc: t.mcUsd != null ? t.mcUsd : 0,
      priceChangeH1: chg1h,
      dev: dev,
      call: callFor(t.vol1hUsd, chg1h),
      traders1h: t.traders1h,
      swaps: t.swaps,
      launchedAt: t.launchedAt,
    };
  });

  const rows = enriched.filter(Boolean);
  const data = {
    ok: true,
    rows,
    count: rows.length,
    source: "Montra public API (api.montramarkets.xyz)",
    updatedAt: new Date().toISOString(),
  };
  cache = { at: Date.now(), data };
  return sendJson(res, 200, data);
};
