// Crocc — /api/ask
// Vercel serverless function. Answers "Ask Crocc anything on chain"
// questions for real: it reads the visitor's question, pulls live Montra
// token data as context, and asks Gemini (gemini-3.5-flash-lite) to
// answer. Montra only — live Montra token data from the Montra public
// API (Elysium, HYPE), with $CROCC featured first.
//
// SETUP: the Gemini key is read ONLY from the GEMINI_API_KEY environment
// variable (Vercel dashboard → Project → Settings → Environment
// Variables). Never write the key into this file or anywhere in code.

const MONTRA_NEW =
  "https://api.montramarkets.xyz/api/tokens?sort=new&limit=25";
const MONTRA_TRENDING =
  "https://api.montramarkets.xyz/api/tokens?sort=trending&limit=25";
const CROCC_CA = "0xd5c1b9aa9016fba63bd70203ff2253ee9efa7724";
const MONTRA_TOKEN = "https://api.montramarkets.xyz/api/tokens/" + CROCC_CA;
const GEMINI_MODEL = "gemini-3.5-flash-lite";
const GEMINI_URL =
  "https://generativelanguage.googleapis.com/v1beta/models/" +
  GEMINI_MODEL +
  ":generateContent";

function sendJson(res, status, obj) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  // Vercel usually pre-parses JSON bodies into req.body; fall back to
  // reading the raw stream so this also works in plain Node runtimes.
  if (req.body && typeof req.body === "object") return Promise.resolve(req.body);
  if (typeof req.body === "string" && req.body) {
    try { return Promise.resolve(JSON.parse(req.body)); } catch (e) { return Promise.resolve({}); }
  }
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => { raw += chunk; });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
}

function fmtUsd(v) {
  const n = Number(v);
  if (!isFinite(n)) return "n/a";
  if (n >= 1e6) return "$" + (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return "$" + (n / 1e3).toFixed(1) + "K";
  return "$" + n.toFixed(2);
}

function fmtPct(v) {
  const n = Number(v);
  if (!isFinite(n)) return "n/a";
  return (n > 0 ? "+" : "") + n.toFixed(1) + "%";
}

function fmtNum(v) {
  const n = Number(v);
  if (!isFinite(n)) return "n/a";
  if (n >= 1e6) return (n / 1e6).toFixed(2) + "M";
  if (n >= 1e3) return (n / 1e3).toFixed(1) + "K";
  return String(Math.round(n * 100) / 100);
}

function tokenLine(t, i) {
  const priceHype = t.price != null ? fmtNum(t.price) + " HYPE" : "n/a";
  const launched = t.launchedAt
    ? new Date(t.launchedAt).toISOString().slice(0, 10)
    : "?";
  const stage =
    t.graduation && t.graduation.stage ? t.graduation.stage : "?";
  return [
    `${i + 1}. ${t.symbol || "?"} (${t.name || "?"})`,
    `price ${priceHype} (${fmtUsd(t.priceUsd)})`,
    `market cap ${fmtUsd(t.marketCapUsd)}`,
    `vol h1 ${fmtUsd(t.volume1hUsd)} / h24 ${fmtUsd(t.volume24hUsd)}`,
    `change 24h ${fmtPct(t.change24hPct)}`,
    `holders ${t.holders ?? "n/a"} / trades ${t.swaps ?? "n/a"}`,
    `launched ${launched} · stage ${stage}`,
  ].join(" · ");
}

function tokenContext(tokens) {
  return tokens.slice(0, 25).map(tokenLine).join("\n");
}

module.exports = async function handler(req, res) {
  if (req.method !== "POST") {
    return sendJson(res, 405, { ok: false, error: "Method not allowed — use POST." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return sendJson(res, 500, {
      ok: false,
      error:
        "GEMINI_API_KEY is not set on the server. Add it as an Environment Variable in the Vercel dashboard (Project → Settings → Environment Variables) and redeploy.",
    });
  }

  const body = await readBody(req);
  const question = String(body.question || "").trim().slice(0, 600);
  if (!question) {
    return sendJson(res, 400, { ok: false, error: "No question was sent." });
  }
  const agents = Math.min(6, Math.max(1, parseInt(body.agents, 10) || 3));

  // 1) Live chain data: $CROCC featured first, then newest + trending
  // Montra tokens from the Montra public API (Elysium).
  let tokens = [];
  let crocc = null;
  let tokensLive = false;
  try {
    const [croccRes, newRes, trendRes] = await Promise.all([
      fetch(MONTRA_TOKEN, { headers: { Accept: "application/json" } }),
      fetch(MONTRA_NEW, { headers: { Accept: "application/json" } }),
      fetch(MONTRA_TRENDING, { headers: { Accept: "application/json" } }),
    ]);
    if (croccRes.ok) {
      try { crocc = await croccRes.json(); } catch (e) { crocc = null; }
    }
    const seen = new Set();
    if (crocc && crocc.address) seen.add(crocc.address.toLowerCase());
    for (const r of [newRes, trendRes]) {
      if (!r.ok) continue;
      const j = await r.json();
      if (Array.isArray(j.tokens)) {
        for (const t of j.tokens) {
          if (t && t.address && !seen.has(t.address.toLowerCase())) {
            seen.add(t.address.toLowerCase());
            tokens.push(t);
          }
        }
      }
    }
    tokensLive = tokens.length > 0 || !!crocc;
  } catch (e) {
    tokens = [];
    crocc = null;
    tokensLive = false;
  }

  const featured = crocc
    ? "FEATURED — $CROCC (this site's token, " + CROCC_CA + "):\n" +
      tokenLine(crocc, 0) + "\n"
    : "";
  const context = tokensLive
    ? featured + (tokens.length ? "LIVE MONTRA TOKENS (newest + trending):\n" + tokenContext(tokens) : "(No other live token data just now.)")
    : "(Live token data could not be fetched from the Montra API just now — say so plainly if the question needs token numbers, and do not invent any.)";

  // 2) Ask Gemini with the question + token data as context.
  const prompt = [
    "You are Crocc, an on-chain AI desk for Montra tokens on Elysium (HYPE).",
    "Answer the visitor's question using ONLY the live token data below for any numbers, prices, volumes, or coin names. Never invent figures that are not in the data. If the data does not cover the question, say that honestly and answer what you can in general terms.",
    "Reply in the same language the visitor used.",
    "Keep the answer under 180 words, plain text, no markdown tables.",
    'Respond with ONLY a JSON object, no code fences: {"verdict":"BUY" | "WATCH" | "PASS" | "ANSWER","coin":"the main coin ticker the answer is about, or empty string","title":"a short headline for the answer, max 8 words","answer":"the full answer text"}',
    "Use verdict BUY, WATCH, or PASS only when the question is about a specific coin or token in the data; otherwise use ANSWER.",
    "",
    "LIVE MONTRA TOKENS (Elysium, $CROCC featured first):",
    context,
    "",
    "VISITOR QUESTION:",
    question,
  ].join("\n");

  let geminiRes;
  try {
    geminiRes = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 900,
          responseMimeType: "application/json",
        },
      }),
    });
  } catch (e) {
    return sendJson(res, 502, {
      ok: false,
      error: "Couldn't reach Gemini from the server. Try again in a moment.",
    });
  }

  if (!geminiRes.ok) {
    let detail = "";
    try {
      const errJson = await geminiRes.json();
      detail = (errJson.error && errJson.error.message) || "";
    } catch (e) { /* keep detail empty */ }
    return sendJson(res, 502, {
      ok: false,
      error:
        "Gemini returned HTTP " + geminiRes.status + (detail ? ": " + detail : "") +
        ". If this is a key error, check the GEMINI_API_KEY environment variable in the Vercel dashboard.",
    });
  }

  const geminiJson = await geminiRes.json();
  const parts =
    (geminiJson.candidates &&
      geminiJson.candidates[0] &&
      geminiJson.candidates[0].content &&
      geminiJson.candidates[0].content.parts) ||
    [];
  const text = parts.map((p) => p.text || "").join("").trim();
  if (!text) {
    return sendJson(res, 502, { ok: false, error: "Gemini replied with an empty answer." });
  }

  let parsed = null;
  try {
    parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
  } catch (e) {
    parsed = null;
  }

  const answer = {
    ok: true,
    question,
    verdict: parsed && parsed.verdict ? String(parsed.verdict).toUpperCase() : "ANSWER",
    coin: parsed && parsed.coin ? String(parsed.coin) : "",
    title: parsed && parsed.title ? String(parsed.title) : "Crocc's answer",
    answer: parsed && parsed.answer ? String(parsed.answer) : text,
    agents,
    mode: "montra",
    model: GEMINI_MODEL,
    poolsLive: tokensLive,
    poolsUsed: tokens.length + (crocc ? 1 : 0),
    fetchedAt: new Date().toISOString(),
  };
  return sendJson(res, 200, answer);
};
