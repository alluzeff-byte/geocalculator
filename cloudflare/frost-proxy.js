// Cloudflare Worker: a small CORS proxy for MET Norway's Frost API (https://frost.met.no), so
// the Geocalculator page (a browser page) can read Frost observations. Frost needs HTTP Basic
// auth with a client ID and sends no CORS headers, so the browser can't call it directly.
//
// - Adds the client ID server-side from the Worker secret FROST_CLIENT_ID, so it never appears
//   in the page source.
// - Only forwards GET requests for the two read-only endpoints the Weather tab uses
//   (/observations/v0.jsonld and /sources/v0.jsonld) - it can't be used as a general proxy.
// - Adds Access-Control-Allow-Origin: * and caches successful responses for 5 minutes at the
//   edge (observations update every 10 min - 1 h), which also keeps request counts to Frost low.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> paste this file ->
// Deploy; then Settings -> Variables and Secrets -> add a Secret named FROST_CLIENT_ID.

const FROST = "https://frost.met.no";
const ALLOWED_PATHS = new Set(["/observations/v0.jsonld", "/sources/v0.jsonld"]);
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    const url = new URL(request.url);
    if (!ALLOWED_PATHS.has(url.pathname)) return new Response("Not found", { status: 404, headers: CORS });
    if (!env.FROST_CLIENT_ID) return new Response("FROST_CLIENT_ID secret is not set", { status: 500, headers: CORS });

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const upstream = await fetch(FROST + url.pathname + url.search, {
      headers: {
        Authorization: "Basic " + btoa(env.FROST_CLIENT_ID + ":"),
        Accept: "application/json",
        "User-Agent": "geocalculator-frost-proxy",
      },
    });
    const headers = new Headers(CORS);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", upstream.ok ? "public, max-age=300" : "no-store");
    const response = new Response(upstream.body, { status: upstream.status, headers });
    if (upstream.ok) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
