/**
 * Internet Archive Addon — Cloudflare Worker (for Eclipse Music)
 *
 * v8 — FINAL: query-term AND-forcing, wider artist coverage.
 *
 * - FIXED completely unrelated search results ("time pink floyd" showing
 *   random podcasts with zero connection to Pink Floyd): archive.org's
 *   search backend does NOT automatically require every space-separated
 *   word to be present when the query is combined with an explicit
 *   `AND mediatype:(audio)` clause — the parser's default term
 *   combination behaves closer to OR once mixed with an explicit AND,
 *   so a query like "(time pink floyd) AND mediatype:(audio)" could
 *   match ANY item containing just the single extremely common word
 *   "time" ANYWHERE in its metadata, with zero requirement that "pink"
 *   or "floyd" appear at all. That's exactly why a "Blackout Podcast"
 *   with no relation to Pink Floyd outranked real Pink Floyd albums.
 *   FIX: every individual word in the query is now explicitly escaped
 *   and joined with real AND operators (buildRequiredTermsQuery), so
 *   ALL words must be present somewhere in the item — matching how
 *   users actually expect multi-word search to behave, and matching
 *   archive.org's own search-bar results for the same query.
 * - Re-added exact-title/creator-match boosting on top of the properly
 *   AND-scoped results, so items with the query terms appearing together
 *   in the title still rank above ones where the terms are merely
 *   scattered across different metadata fields.
 * - FIXED artist pages/search sometimes only showing "a little" of an
 *   artist's real catalog: the creator-scoped candidate pool fetched
 *   before exact-match filtering was too small (80 rows sorted by
 *   downloads) — a real album with modest downloads could simply never
 *   make it into that top-80 pool before filtering even ran. Raised to
 *   200 rows for the artist detail page and 60 for the search page's
 *   creator lookup, so filtering has a much larger, more complete pool
 *   to draw from before narrowing to exact matches.
 *
 * ── Carried over from v7 (unchanged) ──────────────────────────────────────
 * - streamURL removed from track objects; /stream/{id} always returns a
 *   real `quality` string + correct `format`, computed at track-build
 *   time and embedded in the track id (no extra archive.org round-trip).
 * - Artist matching requires an EXACT token match (splitting multi-artist
 *   creator strings) — not substring — so "Future" never pulls in "Odd
 *   Future" or "Future D."
 * - Artwork: real per-item cover file only, omitted when none exists (no
 *   generic thumbnail-service fallback).
 * - No track-count cap on albums/artists/playlists.
 */

// ─── Config ─────────────────────────────────────────────────────────────────
const ADDON_ID = "com.yourname.internetarchive";
const ADDON_NAME = "Internet Archive";
const ADDON_DESC = "Search and stream music, live concerts, audiobooks, old-time radio, and podcasts from the Internet Archive (archive.org). Prefers lossless FLAC/WAV when available.";
const ADDON_ICON = "https://archive.org/images/glogo.jpg";

const ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata";
const ARCHIVE_DOWNLOAD_URL = "https://archive.org/download";

const METADATA_TIMEOUT_FULL_MS = 15000;
const METADATA_TIMEOUT_FAST_MS = 4000;
const SEARCH_TIMEOUT_MS = 6000;

const SEARCH_ENRICH_COUNT = 4;
const SEARCH_ALBUM_LIMIT = 20;
const SEARCH_ARTIST_LIMIT = 8;
const SEARCH_CREATOR_ROWS = 60; // v8: was 20 — wider pool before exact-match filtering
const ARTIST_TOP_TRACK_ITEMS = 5;
const ARTIST_ALBUM_LIMIT = 24;
const ARTIST_CREATOR_ROWS = 200; // v8: was 80 — real low-download albums were getting cut before filtering ran
const PLAYLIST_MAX_ITEMS = 30;
const PLAYLIST_CONCURRENCY = 6;

const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const metadataCache = new Map();

const CATEGORIES = {
  all: { label: "Everything", contentType: "music", collectionFilter: null },
  music: { label: "Music", contentType: "music", collectionFilter: "(collection:(opensource_audio) OR collection:(netlabels) OR collection:(78rpm) OR collection:(etree))" },
  concerts: { label: "Live Concerts", contentType: "music", collectionFilter: "(collection:(etree))" },
  audiobooks: { label: "Audiobooks", contentType: "audiobook", collectionFilter: "(collection:(librivoxaudio))" },
  podcasts: { label: "Podcasts", contentType: "podcast", collectionFilter: "(collection:(podcasts))" },
  radio: { label: "Old-Time Radio", contentType: "podcast", collectionFilter: "(collection:(oldtimeradio) OR collection:(radioprograms))" },
};
const KNOWN_ROUTES = new Set(["manifest.json", "search", "stream", "album", "artist", "playlist"]);

// ─── Small helpers ──────────────────────────────────────────────────────────
function corsHeaders() {
  return { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET, OPTIONS", "Access-Control-Allow-Headers": "*" };
}
function jsonResp(data, status = 200, cacheAge = 0) {
  const headers = { "Content-Type": "application/json", ...corsHeaders() };
  headers["Cache-Control"] = cacheAge > 0 && status === 200 ? `public, max-age=${cacheAge}, s-maxage=${cacheAge}` : "no-store";
  return new Response(JSON.stringify(data, null, 2), { status, headers });
}
function htmlResp(html) {
  return new Response(html, { headers: { "Content-Type": "text/html; charset=utf-8", ...corsHeaders(), "Cache-Control": "no-store" } });
}
function stripHtml(html) {
  return String(html || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
}
function luceneEscape(q) {
  return String(q || "").replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}
function cleanText(str, maxLen = 80) {
  const cleaned = String(str || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trim() + "…";
}

// v8: THE core search fix. Splits the user's query into individual words
// and joins them with explicit AND operators (each word quoted/escaped),
// so archive.org's search requires EVERY word to be present somewhere in
// the item — instead of the loose, near-OR behavior that let a single
// common word like "time" match totally unrelated items.
function buildRequiredTermsQuery(query) {
  const words = String(query || "").trim().split(/\s+/).filter(Boolean);
  if (!words.length) return "";
  return words.map((w) => `"${luceneEscape(w)}"`).join(" AND ");
}

function b64urlEncode(obj) {
  const json = JSON.stringify(obj);
  const b64 = btoa(unescape(encodeURIComponent(json)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function b64urlDecode(str) {
  let b64 = String(str).replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  const json = decodeURIComponent(escape(atob(b64)));
  return JSON.parse(json);
}
function generateToken24() {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function parseCategoryFromSlug(slug) {
  const idx = slug.indexOf("-");
  if (idx === -1) return null;
  const cat = slug.slice(0, idx);
  const token = slug.slice(idx + 1);
  if (!/^[0-9a-f]{24}$/.test(token)) return null;
  if (!CATEGORIES[cat]) return null;
  return cat;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const current = idx++;
      results[current] = await fn(items[current], current);
    }
  }
  const workers = Array.from({ length: Math.min(limit, items.length) }, worker);
  await Promise.all(workers);
  return results;
}

// ─── Artist name matching ───────────────────────────────────────────────────
function splitCreatorTokens(name) {
  return String(name || "")
    .split(/[;,&/]| feat\.?| featuring | x | with /i)
    .map((s) => s.trim())
    .filter(Boolean);
}
function creatorFieldMatchesExactly(creatorField, targetLower) {
  const names = Array.isArray(creatorField) ? creatorField : creatorField ? [creatorField] : [];
  for (const name of names) {
    if (name.trim().toLowerCase() === targetLower) return true;
    for (const token of splitCreatorTokens(name)) {
      if (token.toLowerCase() === targetLower) return true;
    }
  }
  return false;
}

function boostExactMatches(docs, query) {
  const q = String(query || "").trim().toLowerCase();
  if (!q) return docs;
  const strong = [];
  const rest = [];
  for (const d of docs) {
    const title = (d.title || "").toLowerCase();
    const creators = Array.isArray(d.creator) ? d.creator.join(" ").toLowerCase() : (d.creator || "").toLowerCase();
    if (title.includes(q) || creators.includes(q)) strong.push(d);
    else rest.push(d);
  }
  return [...strong, ...rest];
}

// ─── archive.org API calls ──────────────────────────────────────────────────
async function archiveSearch({ q, rows = 25, page = 1, sort = null, fields = ["identifier", "title", "creator", "date", "downloads", "mediatype", "collection"] }) {
  const url = new URL(ARCHIVE_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");
  if (sort) url.searchParams.append("sort[]", sort);
  for (const f of fields) url.searchParams.append("fl[]", f);
  try {
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!r.ok) return [];
    const d = await r.json();
    return d?.response?.docs || [];
  } catch (e) {
    return [];
  }
}

async function archiveMetadata(identifier, timeoutMs = METADATA_TIMEOUT_FULL_MS) {
  const cached = metadataCache.get(identifier);
  if (cached && Date.now() - cached.ts < METADATA_CACHE_TTL_MS) return cached.data;
  try {
    const r = await fetch(`${ARCHIVE_METADATA_URL}/${encodeURIComponent(identifier)}`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!r.ok) return null;
    const d = await r.json();
    metadataCache.set(identifier, { data: d, ts: Date.now() });
    return d;
  } catch (e) {
    return null;
  }
}

function dedupeDocsByIdentifier(lists) {
  const seen = new Set();
  const out = [];
  for (const list of lists) {
    for (const d of list) {
      if (!d?.identifier || seen.has(d.identifier)) continue;
      seen.add(d.identifier);
      out.push(d);
    }
  }
  return out;
}

// ─── Audio file filtering, scoring, grouping ───────────────────────────────
const AUDIO_FORMAT_KEYWORDS = /flac|mp3|ogg|vorbis|\bwav\b|wave|ape|alac|aiff|shorten|\bshn\b|m4a|aac|opus/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif)$/i;

function isAudioFile(file) {
  if (!file || !file.name || !file.format) return false;
  return AUDIO_FORMAT_KEYWORDS.test(file.format);
}
function isLosslessFile(file) {
  return /24bit flac|flac|wave|\bwav\b|apple lossless|alac/i.test(file.format || "");
}

function formatScore(file, preferLossless) {
  const f = (file.format || "").toLowerCase();
  const lossless = isLosslessFile(file);
  if (preferLossless) {
    if (/24bit flac/.test(f)) return 100;
    if (/flac/.test(f)) return 95;
    if (/wave|\bwav\b/.test(f)) return 92;
    if (/apple lossless|alac/.test(f)) return 90;
    if (/vbr mp3/.test(f)) return 60;
    if (/320kbps mp3/.test(f)) return 58;
    if (/ogg vorbis/.test(f)) return 55;
    if (/256kbps mp3/.test(f)) return 50;
    if (/192kbps mp3/.test(f)) return 40;
    if (/128kbps mp3/.test(f)) return 30;
    if (/mp3/.test(f)) return 25;
    if (/m4a|aac/.test(f)) return 20;
    return 5;
  }
  if (lossless) return 65;
  if (/vbr mp3/.test(f)) return 70;
  if (/320kbps mp3/.test(f)) return 68;
  if (/256kbps mp3/.test(f)) return 60;
  if (/ogg vorbis/.test(f)) return 55;
  if (/192kbps mp3/.test(f)) return 50;
  if (/128kbps mp3/.test(f)) return 40;
  if (/mp3/.test(f)) return 35;
  if (/m4a|aac/.test(f)) return 30;
  return 10;
}

function mapFormatField(file) {
  const f = (file.format || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (f.includes("flac") || name.endsWith(".flac")) return "flac";
  if (f.includes("wave") || f.includes("wav") || name.endsWith(".wav")) return "flac";
  if (f.includes("m4a") || name.endsWith(".m4a")) return "m4a";
  if (f.includes("aac") || name.endsWith(".aac")) return "aac";
  if (f.includes("ogg") || f.includes("vorbis") || name.endsWith(".ogg")) return "aac";
  return "mp3";
}

function qualityLabelForFile(file) {
  const raw = (file.format || "").trim();
  const f = raw.toLowerCase();
  if (/24bit flac/.test(f)) return "24-bit FLAC (Lossless)";
  if (/flac/.test(f)) return "FLAC (Lossless)";
  if (/wave|\bwav\b/.test(f)) return "WAV (Lossless)";
  if (/apple lossless|alac/.test(f)) return "Apple Lossless (ALAC)";
  if (/vbr mp3/.test(f)) return "VBR MP3";
  if (/320kbps mp3/.test(f)) return "320kbps MP3";
  if (/256kbps mp3/.test(f)) return "256kbps MP3";
  if (/192kbps mp3/.test(f)) return "192kbps MP3";
  if (/128kbps mp3/.test(f)) return "128kbps MP3";
  if (/64kbps mp3/.test(f)) return "64kbps MP3";
  if (/mp3/.test(f)) return "MP3";
  if (/ogg vorbis/.test(f)) return "Ogg Vorbis";
  if (/m4a/.test(f)) return "M4A";
  if (/aac/.test(f)) return "AAC";
  return raw || "Standard";
}

const RENDITION_SUFFIX_RE = /[_\-\s]?(64kb?ps?|128kb?ps?|192kb?ps?|256kb?ps?|320kb?ps?|vbr|64k|128k|192k|256k|320k)$/i;
function normalizeBaseName(filename) {
  let base = String(filename || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  let prev;
  do {
    prev = base;
    base = base.replace(RENDITION_SUFFIX_RE, "");
  } while (base !== prev);
  return base.replace(/[_\-.]+/g, " ").replace(/\s+/g, " ").trim().toLowerCase();
}

function parseTrackNumber(file) {
  if (file.track) {
    const n = parseInt(String(file.track).split("/")[0], 10);
    if (!isNaN(n)) return n;
  }
  const m = (file.name || "").match(/^(\d{1,3})[\s._-]/);
  if (m) return parseInt(m[1], 10);
  return null;
}
function groupKeyForFile(file) {
  const tn = parseTrackNumber(file);
  if (tn != null) return `#${tn}`;
  return `n:${normalizeBaseName(file.name)}`;
}

function parseDurationSeconds(file) {
  if (!file?.length) return undefined;
  const raw = String(file.length).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(parseFloat(raw));
  const parts = raw.split(":").map(Number);
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}
function bestDurationForGroup(group) {
  const mp3Sibling = group.members?.find((f) => /mp3/i.test(f.format || "") && f.length);
  return parseDurationSeconds(mp3Sibling) ?? parseDurationSeconds(group.file) ?? 0;
}

function fileTitle(file) {
  const raw = file.title && String(file.title).trim();
  if (raw) return cleanText(raw, 90);
  let cleaned = (file.name || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^\d{1,3}[\s._-]+/, "")
    .replace(/[_]+/g, " ")
    .trim();
  if (!cleaned) cleaned = (file.name || "").replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  if (!cleaned) cleaned = file.name || "Untitled Track";
  if (/^\d+$/.test(cleaned)) cleaned = `Track ${cleaned}`;
  return cleanText(cleaned, 90);
}

function groupAudioFiles(files, preferLossless) {
  const audioFiles = (files || []).filter(isAudioFile);
  const groups = new Map();
  for (const file of audioFiles) {
    const key = groupKeyForFile(file);
    const score = formatScore(file, preferLossless);
    let g = groups.get(key);
    if (!g) {
      g = { file, score, trackNumber: parseTrackNumber(file), members: [] };
      groups.set(key, g);
    }
    g.members.push(file);
    if (score > g.score) { g.file = file; g.score = score; }
    if (g.trackNumber == null) g.trackNumber = parseTrackNumber(file);
  }
  for (const g of groups.values()) {
    if (preferLossless && !isLosslessFile(g.file)) {
      const losslessMember = g.members.find(isLosslessFile);
      if (losslessMember) g.file = losslessMember;
    }
  }
  const list = [...groups.values()];
  list.sort((a, b) => {
    if (a.trackNumber != null && b.trackNumber != null) return a.trackNumber - b.trackNumber;
    if (a.trackNumber != null) return -1;
    if (b.trackNumber != null) return 1;
    return (a.file.name || "").localeCompare(b.file.name || "");
  });
  return list;
}

function creatorName(meta) {
  const c = meta?.metadata?.creator;
  if (!c) return "Unknown";
  const arr = Array.isArray(c) ? c : [c];
  const names = arr.map(String).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return "Unknown";
  if (names.length > 3) return cleanText(`${names.slice(0, 3).join(", ")} & others`, 60);
  return cleanText(names.join(", "), 60);
}

function resolveArtwork(identifier, files) {
  if (!Array.isArray(files)) return undefined;
  const tagged = files.find((f) => f.name && IMAGE_EXT.test(f.name) && /item tile|item image|thumbnail/i.test(f.format || ""));
  if (tagged) return downloadUrl(identifier, tagged.name);
  const named = files.find((f) => f.name && IMAGE_EXT.test(f.name) && /cover|front|folder/i.test(f.name));
  if (named) return downloadUrl(identifier, named.name);
  return undefined;
}

function downloadUrl(identifier, filename) {
  return `${ARCHIVE_DOWNLOAD_URL}/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
}
function findPairedVideo(files, baseKey) {
  return (files || []).find((f) => VIDEO_EXT.test(f.name || "") && normalizeBaseName(f.name) === baseKey) || null;
}

function buildTrackFromGroup(identifier, group, meta, includeVideo, allFiles) {
  const file = group.file;
  const artworkURL = resolveArtwork(identifier, allFiles);
  const format = mapFormatField(file);
  const quality = qualityLabelForFile(file);
  const track = {
    id: b64urlEncode({ i: identifier, f: file.name, fmt: format, q: quality }),
    title: fileTitle(file),
    artist: creatorName(meta),
    album: cleanText(meta?.metadata?.title || identifier, 90),
    duration: bestDurationForGroup(group),
    format,
  };
  if (artworkURL) track.artworkURL = artworkURL;
  if (Number.isInteger(group.trackNumber)) track.trackNumber = group.trackNumber;
  if (includeVideo) {
    const vid = findPairedVideo(allFiles, normalizeBaseName(file.name));
    if (vid) {
      track.video = {
        url: downloadUrl(identifier, vid.name),
        mimeType: vid.name.toLowerCase().endsWith(".webm") ? "video/webm" : "video/mp4",
        muxed: true,
      };
    }
  }
  return track;
}

// ─── Manifest ───────────────────────────────────────────────────────────────
function manifest(category) {
  const cat = CATEGORIES[category] || CATEGORIES.all;
  return {
    id: `${ADDON_ID}.${category}`,
    name: category === "all" ? ADDON_NAME : `${ADDON_NAME} — ${cat.label}`,
    version: "8.0.0",
    description: ADDON_DESC,
    icon: ADDON_ICON,
    resources: ["search", "stream", "catalog", "settings"],
    types: ["track", "album", "artist", "playlist"],
    contentType: cat.contentType,
    settings: [
      {
        key: "preferLossless",
        type: "toggle",
        label: "Prefer lossless audio",
        help: "When an item has both FLAC/WAV and MP3 copies of the same recording, stream the lossless one. Turn off to prefer smaller MP3/Ogg files.",
        default: true,
      },
      {
        key: "includeVideo",
        type: "toggle",
        label: "Include paired video when available",
        help: "Some archive.org recordings include a matching video file alongside the audio. When on, Eclipse shows a video toggle for those tracks.",
        default: false,
      },
    ],
  };
}

function landingHTML(base) {
  const buttons = Object.entries(CATEGORIES)
    .map(([key, c]) => `<button type="button" class="cat-btn" data-cat="${key}">${c.label}</button>`)
    .join("\n    ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ADDON_NAME} for Eclipse</title>
<style>
  * { box-sizing: border-box; }
  body { background:#0a0a0a; color:#e8e8e8; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card { max-width:520px; width:100%; background:#111; border:1px solid #222; border-radius:16px; padding:32px; }
  h1 { margin:0 0 8px; font-size:20px; }
  p { color:#999; font-size:14px; line-height:1.6; }
  .cats { display:flex; flex-wrap:wrap; gap:8px; margin:18px 0; }
  .cat-btn { flex:1 1 auto; min-width:120px; background:#1a1a1a; border:1px solid #2a2a2a; color:#e8e8e8; border-radius:10px; padding:11px 10px; font-size:13px; font-weight:600; cursor:pointer; }
  .cat-btn:hover { border-color:#3ecf6b; }
  .cat-btn.active { background:#fff; color:#000; border-color:#fff; }
  .box { display:none; background:#0a0a0a; border:1px solid #1a1a1a; border-radius:10px; padding:14px; margin-top:14px; }
  .box.show { display:block; }
  .lbl { font-size:11px; color:#555; text-transform:uppercase; letter-spacing:.05em; margin-bottom:6px; }
  .url { font-size:12px; color:#fff; word-break:break-all; font-family:monospace; line-height:1.5; }
  .cp { margin-top:10px; background:transparent; border:1px solid #2a2a2a; color:#ccc; font-size:12px; padding:6px 12px; border-radius:6px; }
  code { background:#000; padding:2px 6px; border-radius:4px; color:#fff; }
</style>
</head>
<body>
<div class="card">
  <h1>${ADDON_NAME} for Eclipse</h1>
  <p>${ADDON_DESC}</p>
  <p>Pick a focus below to generate a manifest link scoped to that content type, or install the root <code>/manifest.json</code> directly for everything with a generic "music" player.</p>
  <div class="cats">
    ${buttons}
  </div>
  <div class="box" id="box">
    <div class="lbl">Manifest URL</div>
    <div class="url" id="mUrl"></div>
    <button class="cp" type="button" onclick="copyUrl()">Copy</button>
  </div>
</div>
<script>
document.querySelectorAll('.cat-btn').forEach(function (btn) {
  btn.addEventListener('click', async function () {
    document.querySelectorAll('.cat-btn').forEach(function (b) { b.classList.remove('active'); });
    btn.classList.add('active');
    try {
      const r = await fetch('/generate?category=' + encodeURIComponent(btn.dataset.cat));
      const d = await r.json();
      document.getElementById('mUrl').textContent = d.manifestUrl;
      document.getElementById('box').classList.add('show');
    } catch (e) {
      document.getElementById('mUrl').textContent = 'Could not generate a link. Try again.';
      document.getElementById('box').classList.add('show');
    }
  });
});
function copyUrl() {
  navigator.clipboard.writeText(document.getElementById('mUrl').textContent);
}
</script>
</body>
</html>`;
}

// ─── Route handlers ─────────────────────────────────────────────────────────
async function generateHandler(u, base) {
  const category = (u.searchParams.get("category") || "all").toLowerCase();
  if (!CATEGORIES[category]) return jsonResp({ error: "Unknown category", validCategories: Object.keys(CATEGORIES) }, 400);
  const token = generateToken24();
  const slug = `${category}-${token}`;
  return jsonResp({ category, token, manifestUrl: `${base}/${slug}/manifest.json` });
}

async function searchHandler(u, category) {
  const q = (u.searchParams.get("q") || "").trim();
  if (!q) return jsonResp({ tracks: [], albums: [], artists: [], playlists: [] }, 200, 60);

  const preferLossless = u.searchParams.get("preferLossless") !== "false";
  const includeVideo = u.searchParams.get("includeVideo") === "true";
  const catDef = CATEGORIES[category] || CATEGORIES.all;
  const catFilter = catDef.collectionFilter ? ` AND ${catDef.collectionFilter}` : "";
  const lucQ = luceneEscape(q);

  // v8: relevanceQuery now requires EVERY word to be present (see
  // buildRequiredTermsQuery) — this is the actual search-quality fix.
  const requiredTerms = buildRequiredTermsQuery(q);
  const relevanceQuery = `(${requiredTerms}) AND mediatype:(audio)${catFilter}`;
  const creatorQuery = `creator:("${lucQ}") AND mediatype:(audio)${catFilter}`;

  const [relevanceDocsRaw, creatorDocsRaw] = await Promise.all([
    archiveSearch({ q: relevanceQuery, rows: 30, sort: null }),
    archiveSearch({ q: creatorQuery, rows: SEARCH_CREATOR_ROWS, sort: "downloads desc" }),
  ]);
  const relevanceDocs = boostExactMatches(relevanceDocsRaw, q);

  const qLower = q.toLowerCase();
  const creatorDocs = creatorDocsRaw.filter((d) => creatorFieldMatchesExactly(d.creator, qLower));

  const docs = dedupeDocsByIdentifier([creatorDocs, relevanceDocs]);

  const albums = docs.slice(0, SEARCH_ALBUM_LIMIT).map((d) => ({
    id: d.identifier,
    title: cleanText(d.title || d.identifier, 80),
    artist: cleanText(Array.isArray(d.creator) ? d.creator.join(", ") : d.creator || "Unknown", 60),
    year: (d.date || "").slice(0, 4) || undefined,
  }));

  const topDocs = docs.slice(0, SEARCH_ENRICH_COUNT);
  const metas = await Promise.all(topDocs.map((d) => archiveMetadata(d.identifier, METADATA_TIMEOUT_FAST_MS)));
  const tracks = [];
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 6);
    for (const g of groups) tracks.push(buildTrackFromGroup(topDocs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  const artistMap = new Map();
  for (const d of creatorDocs) {
    const names = Array.isArray(d.creator) ? d.creator : d.creator ? [d.creator] : [];
    for (const name of names) {
      for (const token of splitCreatorTokens(name)) {
        if (token.toLowerCase() === qLower && !artistMap.has(token)) artistMap.set(token, d);
      }
    }
  }
  const artists = [...artistMap.entries()].slice(0, SEARCH_ARTIST_LIMIT).map(([name]) => ({
    id: b64urlEncode({ c: name }),
    name: cleanText(name, 60),
  }));

  return jsonResp({ tracks, albums, artists, playlists: [] }, 200, 120);
}

async function streamHandler(idParam) {
  let identifier, filename, format, quality;
  try {
    ({ i: identifier, f: filename, fmt: format, q: quality } = b64urlDecode(idParam));
  } catch (e) {
    return jsonResp({ error: "Invalid track id" }, 400);
  }
  if (!identifier || !filename) return jsonResp({ error: "Invalid track id" }, 400);
  const url = downloadUrl(identifier, filename);
  return jsonResp({
    url,
    format: format || mapFormatField({ name: filename }),
    quality: quality || (/flac|wav|alac/i.test(filename) ? "Lossless" : "Standard"),
  });
}

async function albumHandler(identifier, u) {
  const preferLossless = u.searchParams.get("preferLossless") !== "false";
  const includeVideo = u.searchParams.get("includeVideo") === "true";
  const debug = u.searchParams.get("debug") === "1";

  const meta = await archiveMetadata(identifier, METADATA_TIMEOUT_FULL_MS);
  if (!meta || !Array.isArray(meta.files)) return jsonResp({ tracks: [], error: "Item not found or timed out loading from Internet Archive" }, 404);

  const groups = groupAudioFiles(meta.files, preferLossless);

  if (debug) {
    return jsonResp({
      fileCount: meta.files.length,
      groupCount: groups.length,
      resolvedArtwork: resolveArtwork(identifier, meta.files) || null,
      groups: groups.map((g) => ({
        file: g.file.name,
        format: g.file.format,
        mappedFormat: mapFormatField(g.file),
        qualityLabel: qualityLabelForFile(g.file),
        score: g.score,
        trackNumber: g.trackNumber,
        chosenDuration: bestDurationForGroup(g),
        memberFiles: g.members.map((m) => ({ name: m.name, format: m.format, track: m.track })),
      })),
    }, 200, 0);
  }

  const tracks = groups.map((g) => buildTrackFromGroup(identifier, g, meta, includeVideo, meta.files));
  const artworkURL = resolveArtwork(identifier, meta.files);

  const result = {
    id: identifier,
    title: cleanText(meta.metadata?.title || identifier, 80),
    artist: creatorName(meta),
    year: (meta.metadata?.date || "").slice(0, 4) || undefined,
    description: meta.metadata?.description ? cleanText(stripHtml(meta.metadata.description), 250) : undefined,
    trackCount: tracks.length,
    tracks,
  };
  if (artworkURL) result.artworkURL = artworkURL;
  return jsonResp(result, 200, 300);
}

async function artistHandler(idParam, u) {
  let creator;
  try {
    ({ c: creator } = b64urlDecode(idParam));
  } catch (e) {
    return jsonResp({ error: "Invalid artist id" }, 400);
  }
  const preferLossless = u.searchParams.get("preferLossless") !== "false";
  const includeVideo = u.searchParams.get("includeVideo") === "true";
  const lucC = luceneEscape(creator);
  const creatorLower = creator.trim().toLowerCase();

  const rawDocs = await archiveSearch({ q: `creator:("${lucC}") AND mediatype:(audio)`, rows: ARTIST_CREATOR_ROWS, sort: "downloads desc" });
  const docs = rawDocs.filter((d) => creatorFieldMatchesExactly(d.creator, creatorLower)).slice(0, ARTIST_ALBUM_LIMIT);

  const albums = docs.map((d) => ({
    id: d.identifier,
    title: cleanText(d.title || d.identifier, 80),
    artist: cleanText(creator, 60),
    year: (d.date || "").slice(0, 4) || undefined,
  }));

  const topDocs = docs.slice(0, ARTIST_TOP_TRACK_ITEMS);
  const metas = await Promise.all(topDocs.map((d) => archiveMetadata(d.identifier, METADATA_TIMEOUT_FAST_MS)));
  const topTracks = [];
  let artistArtwork;
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    if (!artistArtwork) {
      const found = resolveArtwork(topDocs[idx].identifier, meta.files);
      if (found) artistArtwork = found;
    }
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 3);
    for (const g of groups) topTracks.push(buildTrackFromGroup(topDocs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  const result = { id: idParam, name: cleanText(creator, 60), topTracks, albums };
  if (artistArtwork) result.artworkURL = artistArtwork;
  return jsonResp(result, 200, 300);
}

async function playlistHandler(identifier, u) {
  const preferLossless = u.searchParams.get("preferLossless") !== "false";
  const includeVideo = u.searchParams.get("includeVideo") === "true";

  const collectionMeta = await archiveMetadata(identifier, METADATA_TIMEOUT_FAST_MS);
  const docs = await archiveSearch({ q: `collection:(${identifier}) AND mediatype:(audio)`, rows: PLAYLIST_MAX_ITEMS, sort: "downloads desc" });

  const metas = await mapWithConcurrency(docs, PLAYLIST_CONCURRENCY, (d) => archiveMetadata(d.identifier, METADATA_TIMEOUT_FAST_MS));
  const tracks = [];
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 1);
    for (const g of groups) tracks.push(buildTrackFromGroup(docs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  const cName = collectionMeta ? creatorName(collectionMeta) : "Unknown";
  const artworkURL = collectionMeta ? resolveArtwork(identifier, collectionMeta.files) : undefined;

  const result = {
    id: identifier,
    title: cleanText(collectionMeta?.metadata?.title || identifier, 80),
    description: collectionMeta?.metadata?.description ? cleanText(stripHtml(collectionMeta.metadata.description), 250) : undefined,
    creator: cName !== "Unknown" ? cName : undefined,
    tracks,
  };
  if (artworkURL) result.artworkURL = artworkURL;
  return jsonResp(result, 200, 300);
}

// ─── Router ──────────────────────────────────────────────────────────────────
export default {
  async fetch(request) {
    try {
      return await handleRequest(request);
    } catch (err) {
      return jsonResp({ error: "Worker error", message: err.message }, 500);
    }
  },
};

async function handleRequest(request) {
  if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });

  const u = new URL(request.url);
  const base = `${u.protocol}//${u.host}`;
  const parts = u.pathname.split("/").filter(Boolean);

  if (!parts.length) return htmlResp(landingHTML(base));
  if (parts[0] === "generate") return await generateHandler(u, base);

  let category = "all";
  let routeParts = parts;
  if (!KNOWN_ROUTES.has(parts[0])) {
    const cat = parseCategoryFromSlug(parts[0]);
    if (!cat) return jsonResp({ error: "Not found" }, 404);
    category = cat;
    routeParts = parts.slice(1);
  }

  const seg = routeParts[0];
  if (seg === "manifest.json") return jsonResp(manifest(category), 200, 3600);
  if (seg === "search") return await searchHandler(u, category);
  if (seg === "stream" && routeParts[1]) return await streamHandler(routeParts[1]);
  if (seg === "album" && routeParts[1]) return await albumHandler(decodeURIComponent(routeParts[1]), u);
  if (seg === "artist" && routeParts[1]) return await artistHandler(routeParts[1], u);
  if (seg === "playlist" && routeParts[1]) return await playlistHandler(decodeURIComponent(routeParts[1]), u);

  return jsonResp({ error: "Not found" }, 404);
}
