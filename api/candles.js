// Crocc — /api/candles
// Vercel serverless function. Proxies the Montra public API's candle
// endpoint server-side (read-only, no key), so the $CROCC chart works
// where client-side fetches to that host are blocked.
//
// GET /api/candles?address=0x…&interval=5m&limit=100
// Answers: { ok, address, interval, candles: [{ t, open, high, low,
//   close, volumeQuote, volumeToken, trades }] }
// interval: 1m | 5m | 15m | 1h | 4h | 1d (default 5m); limit 1–500.

const MONTRA = "https://api.montramarkets.xyz";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const INTERVALS = new Set(["1m", "5m", "15m", "1h", "4h", "1d"]);

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "s-maxage=30, stale-while-revalidate=60");
  res.end(JSON.stringify(obj));
}

function num(v) {
  const n = Number(v);
  return isFinite(n) ? n : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed — use GET." });
  }
  const q = req.query || {};
  const address = String(q.address || "").trim();
  if (!ADDRESS_RE.test(address)) {
    return sendJson(res, 400, { ok: false, error: "Send a valid token address as ?address=0x…" });
  }
  const interval = INTERVALS.has(String(q.interval)) ? String(q.interval) : "5m";
  let limit = parseInt(q.limit, 10);
  if (!isFinite(limit)) limit = 100;
  limit = Math.min(500, Math.max(1, limit));

  let j;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(
        MONTRA + "/api/tokens/" + address + "/candles?interval=" + interval + "&limit=" + limit,
        { headers: { Accept: "application/json" }, signal: ctrl.signal }
      );
      if (r.status === 404) {
        return sendJson(res, 404, { ok: false, error: "No candles for that token." });
      }
      if (!r.ok) throw new Error("Montra API returned HTTP " + r.status);
      j = await r.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      error: "Couldn't reach the Montra API from the server. Try again in a moment.",
    });
  }

  const candles = (Array.isArray(j.candles) ? j.candles : [])
    .map((c) => ({
      t: typeof c.t === "number" ? c.t : null,
      open: c.open != null ? String(c.open) : null,
      high: c.high != null ? String(c.high) : null,
      low: c.low != null ? String(c.low) : null,
      close: c.close != null ? String(c.close) : null,
      volumeQuote: c.volumeQuote != null ? String(c.volumeQuote) : null,
      volumeToken: c.volumeToken != null ? String(c.volumeToken) : null,
      trades: typeof c.trades === "number" ? c.trades : null,
    }))
    .filter((c) => c.t != null && c.close != null);

  return sendJson(res, 200, {
    ok: true,
    address,
    interval: j.interval || interval,
    candles,
    updatedAt: new Date().toISOString(),
  });
};
