// Cloudflare Worker: a small proxy for the Geocalculator page's Weather tab, for four APIs that
// need a key the page shouldn't publish (Frost and KNMI also send no CORS headers), and four
// with no key that send no CORS headers (RMI, Rijkswaterstaat, OGIMET, aviationweather.gov):
//
// - MET Norway's Frost API (https://frost.met.no) - HTTP Basic auth with a client ID (Worker
//   secret FROST_CLIENT_ID). Paths /observations/v0.jsonld and /sources/v0.jsonld.
// - KNMI's EDR API (https://api.dataplatform.knmi.nl/edr/v1) - Authorization header with an API
//   key (Worker secret KNMI_API_KEY). Path /knmi/edr/v1/collections/<10-minute observations>/
//   locations/<station id>, forwarded without the /knmi prefix.
// - Météo-France's public observation API (https://public-api.meteofrance.fr) - "apikey" header
//   (Worker secret METEOFRANCE_API_KEY). Path /meteofrance/paquet/horaire?id-departement=..,
//   forwarded to the hourly observations package DPPaquetObs/v2/paquet/horaire.
// - AEMET OpenData (https://opendata.aemet.es) - "api_key" header (Worker secret AEMET_API_KEY).
//   Path /aemet/estacion/<idema>. AEMET answers in two steps - a JSON "datos" link, then the
//   data itself (ISO-8859-15 text) - and the Worker does both, returning the data.
// - RMI Belgium's open-data WFS (https://opendata.meteo.be/service/wfs) - no key, but no CORS
//   headers either. Path /rmi/wfs?..., forwarded as is, for its synop and aws layers only.
// - Rijkswaterstaat's water web services (https://ddapi20-waterwebservices.rijkswaterstaat.nl) -
//   no key, no CORS headers, and its queries are POSTed JSON. Path /rws/<OphalenWaarnemingen or
//   OphalenLaatsteWaarnemingen>?q=<the JSON query>: the Worker POSTs q upstream, so the page's
//   request stays a cacheable GET.
// - OGIMET's SYNOP reports (https://www.ogimet.com/cgi-bin/getsynop) - no key, no CORS
//   headers. Path /ogimet/getsynop?block=<5-digit WMO index>&begin=<YYYYMMDDHHmm>&end=<same>.
// - aviationweather.gov's METAR API (https://aviationweather.gov/api/data/metar) - no key, no
//   CORS headers. Path /awc/metar?ids=<ICAO code>&hours=<1-360>, always as JSON.
//
// The keys are added here, server-side, so they never appear in the page source. Only GET
// requests for those read-only paths are forwarded - it can't be used as a general proxy.
// Adds Access-Control-Allow-Origin: * and caches successful responses for 5 minutes at the edge
// (observations update every 10 min - 1 h), which also keeps request counts upstream low.
//
// Deploy: Cloudflare dashboard -> Workers & Pages -> Create -> Worker -> paste this file ->
// Deploy; then Settings -> Variables and Secrets -> add Secrets FROST_CLIENT_ID, KNMI_API_KEY and
// METEOFRANCE_API_KEY and AEMET_API_KEY.

const FROST = "https://frost.met.no";
const FROST_PATHS = new Set(["/observations/v0.jsonld", "/sources/v0.jsonld"]);
const KNMI = "https://api.dataplatform.knmi.nl";
const KNMI_PATH = /^\/knmi(\/edr\/v1\/collections\/10-minute-in-situ-meteorological-observations\/locations\/[\w-]+)$/;
const METEOFRANCE = "https://public-api.meteofrance.fr/public/DPPaquetObs/v2/paquet/horaire";
const AEMET = "https://opendata.aemet.es/opendata/api/observacion/convencional/datos/estacion/";
const AEMET_PATH = /^\/aemet\/estacion\/(\w+)$/;
const RMI = "https://opendata.meteo.be/service/wfs";
const RMI_LAYERS = /^(synop|aws):\w+$/;
const RWS = "https://ddapi20-waterwebservices.rijkswaterstaat.nl/ONLINEWAARNEMINGENSERVICES/";
const RWS_PATH = /^\/rws\/(OphalenWaarnemingen|OphalenLaatsteWaarnemingen)$/;
const OGIMET = "https://www.ogimet.com/cgi-bin/getsynop";
const AWC = "https://aviationweather.gov/api/data/metar";
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

// The upstream URL and auth headers for an allowed path, or null.
function route(url, env) {
  if (FROST_PATHS.has(url.pathname)) {
    if (!env.FROST_CLIENT_ID) return { error: "FROST_CLIENT_ID secret is not set" };
    return { upstream: FROST + url.pathname + url.search, auth: { Authorization: "Basic " + btoa(env.FROST_CLIENT_ID + ":") } };
  }
  const knmi = KNMI_PATH.exec(url.pathname);
  if (knmi) {
    if (!env.KNMI_API_KEY) return { error: "KNMI_API_KEY secret is not set" };
    return { upstream: KNMI + knmi[1] + url.search, auth: { Authorization: env.KNMI_API_KEY } };
  }
  if (url.pathname === "/meteofrance/paquet/horaire") {
    if (!env.METEOFRANCE_API_KEY) return { error: "METEOFRANCE_API_KEY secret is not set" };
    return { upstream: METEOFRANCE + url.search, auth: { apikey: env.METEOFRANCE_API_KEY } };
  }
  const aemet = AEMET_PATH.exec(url.pathname);
  if (aemet) {
    if (!env.AEMET_API_KEY) return { error: "AEMET_API_KEY secret is not set" };
    return { upstream: AEMET + aemet[1], auth: { api_key: env.AEMET_API_KEY }, twoStep: true };
  }
  if (url.pathname === "/rmi/wfs" && RMI_LAYERS.test(url.searchParams.get("typeNames") || "")) {
    return { upstream: RMI + url.search, auth: {} };
  }
  // OGIMET and aviationweather.gov: the query is rebuilt from checked parameters only.
  if (url.pathname === "/ogimet/getsynop") {
    const p = url.searchParams, block = p.get("block") || "", begin = p.get("begin") || "", end = p.get("end") || "";
    if (!/^\d{5}$/.test(block) || !/^\d{12}$/.test(begin) || !/^\d{12}$/.test(end)) return null;
    return { upstream: `${OGIMET}?${new URLSearchParams({ block, begin, end })}`, auth: {} };
  }
  if (url.pathname === "/awc/metar") {
    const ids = url.searchParams.get("ids") || "", hours = url.searchParams.get("hours") || "";
    if (!/^[A-Z0-9]{3,4}$/.test(ids) || !/^\d{1,3}$/.test(hours) || +hours < 1 || +hours > 360) return null;
    return { upstream: `${AWC}?${new URLSearchParams({ ids, format: "json", hours })}`, auth: {} };
  }
  const rws = RWS_PATH.exec(url.pathname);
  if (rws) {
    const q = url.searchParams.get("q") || "";
    try {
      if (q.length > 4000 || typeof JSON.parse(q) !== "object") return null;
    } catch {
      return null;
    }
    return { upstream: RWS + rws[1], auth: {}, postBody: q };
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    const url = new URL(request.url);
    const r = route(url, env);
    if (!r) return new Response("Not found", { status: 404, headers: CORS });
    if (r.error) return new Response(r.error, { status: 500, headers: CORS });

    const cache = caches.default;
    const cacheKey = new Request(url.toString(), { method: "GET" });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const fetchHeaders = { ...r.auth, Accept: "application/json", "User-Agent": "geocalculator-weather-proxy" };
    let upstream = r.postBody
      ? await fetch(r.upstream, { method: "POST", headers: { ...fetchHeaders, "Content-Type": "application/json" }, body: r.postBody })
      : await fetch(r.upstream, { headers: fetchHeaders });
    if (r.twoStep && upstream.ok) {
      // AEMET: {"estado": 200, "datos": "<url>"} on success, or e.g. {"estado": 404,
      // "descripcion": "No hay datos..."} - passed on with that status.
      const meta = await upstream.json();
      if (meta.estado !== 200 || !meta.datos) {
        return new Response(JSON.stringify(meta), { status: meta.estado || 502, headers: { ...CORS, "Content-Type": "application/json" } });
      }
      upstream = await fetch(meta.datos, { headers: { "User-Agent": "geocalculator-weather-proxy" } });
    }
    const headers = new Headers(CORS);
    headers.set("Content-Type", upstream.headers.get("Content-Type") || "application/json");
    headers.set("Cache-Control", upstream.ok ? "public, max-age=300" : "no-store");
    // (A 204 - e.g. Rijkswaterstaat's "no data" - mustn't be given a body.)
    const response = new Response(upstream.status === 204 ? null : upstream.body, { status: upstream.status, headers });
    if (upstream.status === 200) ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  },
};
