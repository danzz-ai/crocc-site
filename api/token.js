// Crocc — /api/token
// Vercel serverless function. Returns one Montra token's live data from
// the Montra public API (read-only, no key) — server-side, so the page
// never talks to the Montra API directly, and the $CROCC card works
// where client-side fetches to that host are blocked.
//
// GET /api/token?address=0x...
// Answers: { ok, address, name, symbol, price, priceUsd, marketCap,
//   marketCapUsd, holders, swaps, volume24hUsd, volume1hUsd,
//   change24hPct, launchedAt, totalFeePips, updatedAt }

const MONTRA = "https://api.montramarkets.xyz";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

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
  const address = String((req.query && req.query.address) || "").trim();
  if (!ADDRESS_RE.test(address)) {
    return sendJson(res, 400, { ok: false, error: "Send a valid token address as ?address=0x…" });
  }

  let t;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);
    try {
      const r = await fetch(MONTRA + "/api/tokens/" + address, {
        headers: { Accept: "application/json" },
        signal: ctrl.signal,
      });
      if (r.status === 404) {
        return sendJson(res, 404, { ok: false, error: "No Montra token at that address." });
      }
      if (!r.ok) throw new Error("Montra API returned HTTP " + r.status);
      t = await r.json();
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      error: "Couldn't reach the Montra API from the server. Try again in a moment.",
    });
  }

  return sendJson(res, 200, {
    ok: true,
    address: t.address || address,
    name: t.name || "?",
    symbol: t.symbol || "?",
    price: t.price != null ? String(t.price) : null,
    priceUsd: num(t.priceUsd),
    marketCap: num(t.marketCap),
    marketCapUsd: num(t.marketCapUsd),
    holders: typeof t.holders === "number" ? t.holders : null,
    swaps: typeof t.swaps === "number" ? t.swaps : null,
    volume24hUsd: num(t.volume24hUsd),
    volume1hUsd: num(t.volume1hUsd),
    change24hPct: num(t.change24hPct),
    launchedAt: typeof t.launchedAt === "number" ? t.launchedAt : null,
    totalFeePips: typeof t.totalFeePips === "number" ? t.totalFeePips : null,
    updatedAt: new Date().toISOString(),
  });
};
