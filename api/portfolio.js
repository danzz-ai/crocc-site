// Crocc — /api/portfolio
// Vercel serverless function. Reads one wallet's portfolio on Elysium:
// its HYPE balance from the Elysium RPC and its Montra token holdings
// from the Montra public API (read-only, no key) — all server-side, so
// the page never talks to the chain or the Montra API directly, and the
// portfolio works where client-side fetches to those hosts are blocked.
//
// GET /api/portfolio?address=0x...
// Answers: { ok, address, hypeBalance, hypeUsdValue, totalUsd, tokens, updatedAt }
//   tokens: [{ address, symbol, name, balance, usdValue }]
// Balances are display strings (trimmed to 6 decimals). Montra launch
// tokens use 18 decimals — the platform standard — so holdings are
// formatted on that basis.

const ELYSIUM_RPC = "https://rpc.montramarkets.xyz";
const MONTRA = "https://api.montramarkets.xyz";
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function fmtUnits(raw, decimals) {
  if (raw === 0n) return "0";
  const neg = raw < 0n;
  const s = (neg ? -raw : raw).toString().padStart(decimals + 1, "0");
  const int = decimals > 0 ? s.slice(0, s.length - decimals) : s;
  const frac = decimals > 0 ? s.slice(s.length - decimals).slice(0, 6).replace(/0+$/, "") : "";
  return (neg ? "-" : "") + int + (frac ? "." + frac : "");
}

async function fetchJson(url, timeoutMs) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs || 8000);
  try {
    const res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Montra API returned HTTP " + res.status);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}

async function rpcCall(method, params) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(ELYSIUM_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("Elysium RPC returned HTTP " + res.status);
    const body = await res.json();
    if (body.error) throw new Error(body.error.message || "Elysium RPC error");
    return body.result;
  } finally {
    clearTimeout(t);
  }
}

module.exports = async function handler(req, res) {
  if (req.method !== "GET") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed — use GET." });
  }
  const address = String((req.query && req.query.address) || "").trim();
  if (!ADDRESS_RE.test(address)) {
    return sendJson(res, 400, { ok: false, error: "Send a valid wallet address as ?address=0x…" });
  }

  // 1) HYPE balance from the Elysium RPC, 2) token holdings from Montra,
  // 3) the HYPE dollar price (any token card's quote carries it).
  let hypeWei = 0n;
  let holdings = [];
  let hypeUsd = null;
  try {
    const [balanceHex, holdingsJson, trendingJson] = await Promise.all([
      rpcCall("eth_getBalance", [address, "latest"]),
      fetchJson(MONTRA + "/api/wallets/" + address + "/holdings"),
      fetchJson(MONTRA + "/api/tokens?sort=trending&limit=1"),
    ]);
    try {
      hypeWei = BigInt(balanceHex || "0x0");
    } catch (e) {
      hypeWei = 0n;
    }
    if (Array.isArray(holdingsJson.holdings)) holdings = holdingsJson.holdings;
    const first =
      trendingJson.tokens && trendingJson.tokens[0] ? trendingJson.tokens[0] : null;
    if (first && first.quote && typeof first.quote.usd === "number") {
      hypeUsd = first.quote.usd;
    }
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      error:
        "Couldn't read this wallet on Elysium (" +
        (e && e.message ? e.message : String(e)) +
        "). Try again in a moment.",
    });
  }

  const hypeNumeric = Number(hypeWei) / 1e18;
  const hypeUsdValue =
    hypeUsd != null ? hypeNumeric * hypeUsd : hypeWei === 0n ? 0 : null;

  const tokens = holdings
    .map((h) => {
      let raw = 0n;
      try {
        raw = BigInt(h.balance || "0");
      } catch (e) {
        raw = 0n;
      }
      const usdValue = typeof h.valueUsd === "number" ? h.valueUsd : null;
      return {
        address: h.address,
        symbol: h.symbol || "TOKEN",
        name: h.name || h.symbol || "Token",
        balance: fmtUnits(raw, 18),
        usdValue,
      };
    })
    .sort((a, b) => (b.usdValue == null ? -1 : b.usdValue) - (a.usdValue == null ? -1 : a.usdValue));

  const allPriced =
    (hypeWei === 0n || hypeUsdValue != null) &&
    tokens.every((t) => t.usdValue != null);
  const totalUsd = allPriced
    ? (hypeUsdValue || 0) + tokens.reduce((sum, t) => sum + (t.usdValue || 0), 0)
    : null;

  return sendJson(res, 200, {
    ok: true,
    address,
    hypeBalance: fmtUnits(hypeWei, 18),
    hypeUsdValue,
    totalUsd,
    tokens,
    updatedAt: new Date().toISOString(),
  });
};
