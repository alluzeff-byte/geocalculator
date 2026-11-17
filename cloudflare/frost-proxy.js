// Cloudflare Worker: a small proxy for the Geocalculator page's Weather and Meteo tabs, for four
// APIs that need a key the page shouldn't publish (Frost and KNMI also send no CORS headers), and
// ten with no key that send no CORS headers (RMI, Rijkswaterstaat, OGIMET, aviationweather.gov,
// Met Office historic station data, WMO OSCAR/Surface, Cefas WaveNet, NDBC, the Met Office
// Library and Archive, DWD open data):
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
// - Met Office historic station data (https://www.metoffice.gov.uk/pub/data/weather/uk/climate/
//   stationdata) - no key, no CORS headers (Meteo tab). Path /metoffice/<station>data.txt.
// - WMO OSCAR/Surface (https://oscar.wmo.int) - station metadata, no key, no CORS headers (the
//   Weather tab's DLP saver looks up instrument makes and sensor heights). Paths
//   /oscar/search?latitudeMin=..&latitudeMax=..&longitudeMin=..&longitudeMax=.. (station search
//   by box) and /oscar/wmdr?id=<WIGOS id> (the station's WIGOS metadata record, XML).
// - Cefas WaveNet (https://wavenet-api.cefas.co.uk/api) - UK wave buoys, no key, no CORS
//   headers (the WaveNet website's own API). Paths /wavenet/Detail/Results/<buoy>/<INT|EXT> (the
//   last ~36 h, forecasts left out) and /wavenet/Detail/Information/<buoy>/<INT|EXT>.
// - NDBC, the US National Data Buoy Center (https://www.ndbc.noaa.gov) - buoy and coastal
//   station data, no key, no CORS headers. Paths /ndbc/realtime2/<ID>.txt (last 45 days),
//   /ndbc/stdmet/<Mon>/<id>[<month><year>].txt[.gz] (this year's months),
//   /ndbc/historical/stdmet/<id>h<year>.txt.gz (earlier years, gzipped - passed on as is) and
//   /ndbc/station_page?station=<ID> (the station's page: sensor heights, hull, water depth).
// - The Met Office Library and Archive's digital archive (https://metoffice.access.preservica.com,
//   Preservica) - its folder pages, for the Synoptic tab's charts. No key, no CORS headers. Path
//   /nmla/<SO_ or IO_ id>?pg=<page> (the folder's listing page, HTML) and /nmla/download/<IO_ id>
//   (a chart's file - the hemisphere and regional charts are PDFs the page shows itself).
// - The owner's OneDrive (Microsoft Graph) - the Synoptic tab's DWD chart archive; signed in once
//   by the owner, see the OneDrive section below for the setup. Paths /onedrive/...
// - DWD open data (https://opendata.dwd.de/weather/charts/analysis/) - the folder listing of its
//   analysis charts, for the Synoptic tab (the images themselves load directly). Path
//   /dwd/charts/analysis/; and /dwd/charts/analysis/<chart>.png (one analysis chart, for the
//   animation window's Save GIF, which needs CORS to read the image's pixels).
// - The Met Office website's surface pressure charts (https://data.consumer-digital.api.metoffice.
//   gov.uk/v1/surface-pressure) - no CORS headers; for the same Save GIF. Path
//   /mo/surface-pressure/<colour|bw>/<YYYY-MM-DDTHHMM>/<chart>.gif.
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
const METOFFICE = "https://www.metoffice.gov.uk/pub/data/weather/uk/climate/stationdata/";
const METOFFICE_PATH = /^\/metoffice\/([a-z]+data\.txt)$/;
const OSCAR_SEARCH = "https://oscar.wmo.int/surface/rest/api/search/station";
const OSCAR_OAI = "https://oscar.wmo.int/oai/provider";
const WAVENET = "https://wavenet-api.cefas.co.uk/api/Detail/";
const WAVENET_PATH = /^\/wavenet\/Detail\/(Results|Information)\/([A-Za-z0-9_-]{1,24})\/(INT|EXT)$/;
const NDBC = "https://www.ndbc.noaa.gov/";
const NMLA = "https://metoffice.access.preservica.com/";
const NMLA_PATH = /^\/nmla\/((?:SO|IO)_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const NMLA_DOWNLOAD = "https://digital.nmla.metoffice.gov.uk/download/file/";
const DWD_CHART_PATH = /^\/dwd\/charts\/analysis\/(Z__C_EDZW_\d{14}_tka01(?:%2C|%2c|,)ana_bwkman_[a-z]{2,8}_O_000000_000000_\d{12}_(?:WV12|WVHASW)\.png)$/;
const MO_CHART_PATH = /^\/mo\/surface-pressure\/((?:colour|bw)\/\d{4}-\d{2}-\d{2}T\d{4}\/(?:\d{4}_ASXX_Assistant_FC000|FSXX\d{2}T_00)\.gif)$/;
const NMLA_DOWNLOAD_PATH = /^\/nmla\/download\/(IO_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const NDBC_PATH = /^\/ndbc\/(realtime2\/[A-Z0-9]{4,7}\.txt|stdmet\/(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\/[a-z0-9]{4,7}(\d{5,6})?\.txt(\.gz)?|historical\/stdmet\/[a-z0-9]{4,7}h\d{4}\.txt\.gz)$/;
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
  if (url.pathname === "/oscar/search") {
    const p = url.searchParams, keys = ["latitudeMin", "latitudeMax", "longitudeMin", "longitudeMax"];
    if (!keys.every((k) => /^-?\d{1,3}(\.\d{1,6})?$/.test(p.get(k) || ""))) return null;
    return { upstream: `${OSCAR_SEARCH}?${new URLSearchParams(keys.map((k) => [k, p.get(k)]))}`, auth: {} };
  }
  if (url.pathname === "/oscar/wmdr") {
    const id = url.searchParams.get("id") || "";
    if (!/^0-\d{1,5}-\d{1,5}-[\w.-]{1,32}$/.test(id)) return null;
    return { upstream: `${OSCAR_OAI}?${new URLSearchParams({ verb: "GetRecord", metadataPrefix: "wmdr", identifier: id })}`, auth: {} };
  }
  if (url.pathname === "/dwd/charts/analysis/") return { upstream: "https://opendata.dwd.de/weather/charts/analysis/", auth: {} };
  const dwdChart = DWD_CHART_PATH.exec(url.pathname);
  if (dwdChart) return { upstream: `https://opendata.dwd.de/weather/charts/analysis/${dwdChart[1].replace(/,|%2c/, "%2C")}`, auth: {} };
  const moChart = MO_CHART_PATH.exec(url.pathname);
  if (moChart) return { upstream: `https://data.consumer-digital.api.metoffice.gov.uk/v1/surface-pressure/${moChart[1]}`, auth: {} };
  const nmlaFile = NMLA_DOWNLOAD_PATH.exec(url.pathname);
  if (nmlaFile) return { upstream: NMLA_DOWNLOAD + nmlaFile[1], auth: {} };
  const nmla = NMLA_PATH.exec(url.pathname);
  if (nmla) {
    const pg = url.searchParams.get("pg") || "1";
    if (!/^\d{1,2}$/.test(pg)) return null;
    return { upstream: `${NMLA}${nmla[1]}/${pg === "1" ? "" : `?pg=${pg}`}`, auth: {} };
  }
  const ndbc = NDBC_PATH.exec(url.pathname);
  if (ndbc) return { upstream: `${NDBC}data/${ndbc[1]}`, auth: {} };
  if (url.pathname === "/ndbc/station_page") {
    const station = url.searchParams.get("station") || "";
    if (!/^[A-Za-z0-9]{4,7}$/.test(station)) return null;
    return { upstream: `${NDBC}station_page.php?${new URLSearchParams({ station })}`, auth: {} };
  }
  const wavenet = WAVENET_PATH.exec(url.pathname);
  if (wavenet) {
    const [, kind, buoy, src] = wavenet;
    return { upstream: `${WAVENET}${kind}/${buoy}/${src}${kind === "Results" ? "?showForecast=false" : ""}`, auth: {} };
  }
  const metoffice = METOFFICE_PATH.exec(url.pathname);
  if (metoffice) return { upstream: METOFFICE + metoffice[1], auth: {} };
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

// --- OneDrive: the Synoptic tab's DWD chart archive, kept in the app's own OneDrive folder
// (OneDrive/Apps/<app registration name>/), read through Microsoft Graph with the owner's
// delegated sign-in. Its permission is Files.ReadWrite.AppFolder: Microsoft lets the sign-in
// reach that one folder and nothing else on the drive (this Worker only ever reads). Setup, once:
//   1. Microsoft Entra (portal.azure.com -> App registrations -> New registration): "Personal
//      Microsoft accounts only", redirect URI (Web) https://<this worker>/onedrive/callback; then
//      Certificates & secrets -> New client secret.
//   2. Cloudflare: a KV namespace bound to this Worker as ONEDRIVE_KV; secrets ONEDRIVE_CLIENT_ID,
//      ONEDRIVE_CLIENT_SECRET and ONEDRIVE_SETUP_KEY (any long random text); optional variable
//      ONEDRIVE_FOLDER (a sub-folder inside the app folder holding the archive, e.g. "DWD";
//      unset = the app folder itself).
//   3. Open https://<this worker>/onedrive/login?key=<ONEDRIVE_SETUP_KEY> and sign in - OneDrive
//      creates the app folder on the first access (the Worker lists it once right after sign-in);
//      then move or copy the charts into it. The
//      refresh token is kept in KV (Microsoft issues a new one with each access token, so it's
//      stored again every time; KV keeps the current access token for its hour too).
// Paths: /onedrive/dwd/children?path=<folder inside the archive>[&next=<skip token>] (that
// folder's sub-folders and DWD analysis charts, JSON {items: [{name, folder}], next}) and
// /onedrive/dwd/file?path=<chart> (the chart, PNG). Only the archive folder can be read, only
// folders and files named like DWD's analysis charts are listed or served.
const OD_LOGIN = "https://login.microsoftonline.com/consumers/oauth2/v2.0/";
const OD_GRAPH = "https://graph.microsoft.com/v1.0/me/drive/special/approot";
const OD_SCOPE = "Files.ReadWrite.AppFolder offline_access";
const OD_CHART = /^Z__C_EDZW_\d{14}_tka01(?:,|%2C|%2c)ana_bwkman_[a-z]{2,8}_O_000000_000000_\d{12}_(?:WV12|WVHASW)\.png$/;

// A path inside the archive folder ("" = the folder itself), or null if it could leave it.
function odRel(p) {
  if (p.length > 400 || p.startsWith("/") || p.endsWith("/") || /(^|\/)\.{1,2}(\/|$)/.test(p) || /[\\:*?"<>|]/.test(p)) return null;
  return p;
}
function odUrl(env, rel, tail) {
  const segs = [...String(env.ONEDRIVE_FOLDER || "").split("/"), ...rel.split("/")].filter(Boolean);
  return segs.length ? `${OD_GRAPH}:/${segs.map(encodeURIComponent).join("/")}:/${tail}` : `${OD_GRAPH}/${tail}`;
}
const odJson = (body, status = 200, extra = {}) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json", ...extra } });

async function odTokenRequest(env, params) {
  const res = await fetch(OD_LOGIN + "token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: env.ONEDRIVE_CLIENT_ID, client_secret: env.ONEDRIVE_CLIENT_SECRET, scope: OD_SCOPE, ...params }),
  });
  const t = await res.json().catch(() => ({}));
  if (!res.ok || !t.access_token) throw new Error(`Microsoft sign-in failed: ${t.error_description || t.error || `HTTP ${res.status}`}`);
  if (t.refresh_token) await env.ONEDRIVE_KV.put("refresh", t.refresh_token);
  await env.ONEDRIVE_KV.put("access", JSON.stringify({ token: t.access_token, exp: Date.now() + (t.expires_in || 3600) * 1000 }));
  return t.access_token;
}

async function odAccessToken(env) {
  const cached = await env.ONEDRIVE_KV.get("access", "json");
  if (cached && cached.exp > Date.now() + 120000) return cached.token;
  const refresh = await env.ONEDRIVE_KV.get("refresh");
  if (!refresh) throw new Error("The OneDrive archive isn't connected yet - its owner has to open /onedrive/login once.");
  return odTokenRequest(env, { grant_type: "refresh_token", refresh_token: refresh });
}

async function onedrive(request, url, env, ctx) {
  const missing = ["ONEDRIVE_KV", "ONEDRIVE_CLIENT_ID", "ONEDRIVE_CLIENT_SECRET"].filter((k) => !env[k]);
  if (missing.length) {
    return odJson({ error: `The OneDrive archive isn't set up on the Worker - missing: ${missing.join(", ")}.` }, 500, { "Cache-Control": "no-store" });
  }
  const redirectUri = `${url.origin}/onedrive/callback`;
  // The owner's one-time sign-in (the setup key travels as the OAuth state and comes back).
  if (url.pathname === "/onedrive/login" || url.pathname === "/onedrive/callback") {
    const key = url.pathname === "/onedrive/login" ? url.searchParams.get("key") : url.searchParams.get("state");
    if (!env.ONEDRIVE_SETUP_KEY || key !== env.ONEDRIVE_SETUP_KEY) return new Response("Not found", { status: 404, headers: CORS });
    if (url.pathname === "/onedrive/login") {
      const q = new URLSearchParams({ client_id: env.ONEDRIVE_CLIENT_ID, response_type: "code", redirect_uri: redirectUri, response_mode: "query", scope: OD_SCOPE, state: key });
      return Response.redirect(`${OD_LOGIN}authorize?${q}`, 302);
    }
    const code = url.searchParams.get("code");
    if (!code) return new Response(`Sign-in cancelled: ${url.searchParams.get("error_description") || "no code"}`, { status: 400 });
    try {
      const token = await odTokenRequest(env, { grant_type: "authorization_code", code, redirect_uri: redirectUri });
      // (The first access to special/approot makes OneDrive create the app folder.)
      await fetch(`${OD_GRAPH}/children?$top=1`, { headers: { Authorization: `Bearer ${token}` } });
    } catch (err) {
      return new Response(err.message, { status: 502 });
    }
    return new Response("OneDrive connected - put the DWD charts into OneDrive/Apps/<app name>/" + (env.ONEDRIVE_FOLDER ? `${env.ONEDRIVE_FOLDER}/` : "") + " (any sub-folders), then Geocalculator can show them. You can close this page.", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
  }
  if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });
  const rel = odRel(url.searchParams.get("path") || "");
  const isList = url.pathname === "/onedrive/dwd/children", isFile = url.pathname === "/onedrive/dwd/file";
  if (rel === null || !(isList || (isFile && OD_CHART.test(rel.split("/").pop())))) return new Response("Not found", { status: 404, headers: CORS });
  const next = isList ? url.searchParams.get("next") || "" : "";
  if (next && !/^[\w.~%=-]{1,2000}$/.test(next)) return new Response("Not found", { status: 404, headers: CORS });

  const cache = caches.default, cacheKey = new Request(url.toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;
  try {
    const token = await odAccessToken(env);
    if (isList) {
      const q = new URLSearchParams({ $top: "999", $select: "name,folder,file" });
      if (next) q.set("$skiptoken", next);
      const res = await fetch(`${odUrl(env, rel, "children")}?${q}`, { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return odJson({ error: `OneDrive: ${(body.error && body.error.message) || `HTTP ${res.status}`}` }, res.status === 404 ? 404 : 502);
      const items = (body.value || []).filter((it) => it.folder || OD_CHART.test(it.name)).map((it) => ({ name: it.name, folder: !!it.folder }));
      // (The next page's skip token, whatever case Graph gives the parameter.)
      let skip = null;
      if (body["@odata.nextLink"]) for (const [k, v] of new URL(body["@odata.nextLink"]).searchParams) if (/skiptoken/i.test(k)) skip = v;
      const response = odJson({ items, next: skip }, 200, { "Cache-Control": "public, max-age=3600" });
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
      return response;
    }
    // A chart: Graph answers /content with a redirect to a pre-signed download link.
    const meta = await fetch(odUrl(env, rel, "content"), { headers: { Authorization: `Bearer ${token}` }, redirect: "manual" });
    const location = meta.headers.get("Location");
    const file = location ? await fetch(location) : meta;
    if (!file.ok) return odJson({ error: `OneDrive: the chart couldn't be read (HTTP ${file.status}).` }, file.status === 404 ? 404 : 502);
    const headers = new Headers(CORS);
    headers.set("Content-Type", "image/png");
    headers.set("Cache-Control", "public, max-age=86400"); // (archived charts don't change)
    const response = new Response(file.body, { status: 200, headers });
    ctx.waitUntil(cache.put(cacheKey, response.clone()));
    return response;
  } catch (err) {
    return odJson({ error: err.message }, 502);
  }
}

export default {
  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
    if (request.method !== "GET") return new Response("Method not allowed", { status: 405, headers: CORS });

    const url = new URL(request.url);
    if (url.pathname.startsWith("/onedrive/")) return onedrive(request, url, env, ctx);
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
