/**
 * Internet Archive Addon — Cloudflare Worker (for Eclipse Music)
 *
 * Searches, browses, and streams audio directly from archive.org:
 * music, live concerts (etree), audiobooks (LibriVox), old-time radio,
 * podcasts — anything tagged mediatype:audio on the Internet Archive.
 *
 * No auth, no API keys, no secrets. archive.org is fully public.
 *
 * v2 — CATEGORY-SPECIFIC GENERATED MANIFESTS + BUG FIXES:
 * - Landing page now has a "Generate" button per content category (Music,
 *   Live Concerts, Audiobooks, Podcasts, Old-Time Radio, Everything). Each
 *   click makes a manifest.json URL at /{category}-{24-char-token}/... —
 *   the token is random (cosmetic uniqueness, matching Tido's pattern);
 *   the category prefix is what the worker actually reads to pick the
 *   right `contentType` (music/audiobook/podcast) and restrict search to
 *   the matching archive.org collection(s), since Eclipse only supports
 *   ONE contentType per manifest. Root-level requests with no category
 *   slug still work and default to "all" / contentType "music".
 * - FIXED blank-but-clickable track rows: some archive.org filenames
 *   (e.g. bare "01.mp3") produced an empty cleaned title, and duration
 *   was `undefined` instead of 0 when a file had no length metadata.
 *   Track title now always falls back through file.title -> cleaned
 *   filename -> "Track N" -> "Untitled Track", and duration always
 *   defaults to 0 instead of being omitted.
 * - FIXED some albums not loading: very large items (thousands of files)
 *   were timing out against the old 8s fetch limit. The primary
 *   /album/{id} metadata fetch now gets 15s (correctness matters more
 *   there); search/artist/playlist enrichment lookups use a fast 5s
 *   best-effort timeout instead so browsing doesn't feel slow waiting on
 *   one big item.
 * - FIXED search relevance ("panchiko" surfacing an unrelated but more-
 *   downloaded item like "Dismiss Yourself" ahead of it): search no
 *   longer forces sort=downloads desc (pure popularity, ignores text
 *   match quality) for keyword queries. It now uses archive.org's default
 *   relevance ranking, plus a manual boost pass that moves any result
 *   whose title or creator contains the query text to the front.
 * - FIXED "albums loading wider than screen": archive.org titles and
 *   descriptions can be extremely long, unbroken strings. All title,
 *   artist, and description fields are now cleaned (newlines collapsed)
 *   and truncated with an ellipsis at sane lengths.
 * - Search enrichment no longer runs through an artificial concurrency
 *   queue for the small top-N result set — it's fully parallel now,
 *   shaving a bit of latency off every search.
 *
 * ── Mapping onto archive.org ─────────────────────────────────────────────
 * - "album"    -> an archive.org "item" (identifier).
 * - "track"    -> one audio file inside an item's file list (renditions of
 *                 the same recording are grouped; best format wins).
 * - "artist"   -> archive.org's `creator` metadata field (best-effort).
 * - "playlist" -> an archive.org "collection".
 *
 * ── Why streamURL is used everywhere ─────────────────────────────────────
 * archive.org download links never expire and need no signing, so every
 * track includes a direct `streamURL` — Eclipse skips /stream entirely
 * for these. /stream/{id} is still implemented as a required-endpoint
 * fallback.
 */

// ─── Config ─────────────────────────────────────────────────────────────────
const ADDON_ID = "com.yourname.internetarchive";
const ADDON_NAME = "Internet Archive";
const ADDON_DESC = "Search and stream music, live concerts, audiobooks, old-time radio, and podcasts from the Internet Archive (archive.org). Prefers lossless FLAC/WAV when available.";
const ADDON_ICON = "https://archive.org/images/glogo.jpg";

const ARCHIVE_SEARCH_URL = "https://archive.org/advancedsearch.php";
const ARCHIVE_METADATA_URL = "https://archive.org/metadata";
const ARCHIVE_DOWNLOAD_URL = "https://archive.org/download";
const ARCHIVE_THUMB_URL = "https://archive.org/services/img";

const METADATA_TIMEOUT_FULL_MS = 15000; // used for the primary /album/{id} lookup — correctness matters more
const METADATA_TIMEOUT_FAST_MS = 5000; // used for search/artist/playlist enrichment — best-effort, skip on slow
const SEARCH_TIMEOUT_MS = 8000;

const SEARCH_ENRICH_COUNT = 5; // how many top search hits get a real track listing
const ARTIST_TOP_TRACK_ITEMS = 5;
const PLAYLIST_MAX_ITEMS = 30;
const PLAYLIST_CONCURRENCY = 6;

const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const metadataCache = new Map(); // identifier -> { data, ts }

// ── Content categories — each generated manifest link is scoped to one of
// these, since Eclipse only supports a single contentType per addon. ──────
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
  return String(q || "").replace(/"/g, '\\"');
}
// v2: collapses newlines/whitespace and truncates so long archive.org
// titles/descriptions can't blow out Eclipse's fixed-width layout.
function cleanText(str, maxLen = 120) {
  const cleaned = String(str || "").replace(/[\r\n\t]+/g, " ").replace(/\s+/g, " ").trim();
  if (!cleaned) return "";
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.slice(0, maxLen - 1).trim() + "…";
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

// ─── archive.org API calls ──────────────────────────────────────────────────
// v2: sort is optional now — omit it for free-text queries so archive.org
// applies its own relevance ranking instead of pure popularity.
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

// v2: puts any result whose title or creator actually contains the query
// text ahead of results that only matched on some other indexed field —
// fixes cases like "panchiko" surfacing an unrelated, more-downloaded item.
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

// ─── Audio file filtering, scoring, grouping ───────────────────────────────
const AUDIO_FORMAT_KEYWORDS = /flac|mp3|ogg|vorbis|\bwav\b|wave|ape|alac|aiff|shorten|\bshn\b|m4a|aac|opus/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;

function isAudioFile(file) {
  if (!file || !file.name || !file.format) return false;
  return AUDIO_FORMAT_KEYWORDS.test(file.format);
}

function formatScore(file, preferLossless) {
  const f = (file.format || "").toLowerCase();
  const lossless = /24bit flac|flac|wave|\bwav\b|apple lossless|alac/.test(f);
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
  if (f.includes("wave") || f.includes("wav") || name.endsWith(".wav")) return "wav";
  if (f.includes("ogg") || f.includes("vorbis") || name.endsWith(".ogg")) return "ogg";
  if (f.includes("m4a") || name.endsWith(".m4a")) return "m4a";
  if (f.includes("aac") || name.endsWith(".aac")) return "aac";
  return "mp3";
}

function normalizeBaseName(filename) {
  return String(filename || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
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

function parseDurationSeconds(file) {
  if (!file.length) return undefined;
  const raw = String(file.length).trim();
  if (/^\d+(\.\d+)?$/.test(raw)) return Math.round(parseFloat(raw));
  const parts = raw.split(":").map(Number);
  if (parts.some((n) => isNaN(n))) return undefined;
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return undefined;
}

// v2: fixed blank titles — always falls through to a usable string,
// never returns empty (e.g. bare "01.mp3" now becomes "Track 01" instead
// of an empty label that only shows up as a clickable-but-blank row).
function fileTitle(file) {
  const raw = file.title && String(file.title).trim();
  if (raw) return cleanText(raw, 100);
  let cleaned = (file.name || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^\d{1,3}[\s._-]+/, "")
    .replace(/[_]+/g, " ")
    .trim();
  if (!cleaned) cleaned = (file.name || "").replace(/\.[a-z0-9]{2,5}$/i, "").trim();
  if (!cleaned) cleaned = file.name || "Untitled Track";
  if (/^\d+$/.test(cleaned)) cleaned = `Track ${cleaned}`;
  return cleanText(cleaned, 100);
}

function groupAudioFiles(files, preferLossless) {
  const audioFiles = (files || []).filter(isAudioFile);
  const groups = new Map();
  for (const file of audioFiles) {
    const key = normalizeBaseName(file.name);
    const score = formatScore(file, preferLossless);
    const existing = groups.get(key);
    if (!existing || score > existing.score) {
      groups.set(key, { file, score, trackNumber: existing?.trackNumber ?? parseTrackNumber(file) });
    } else if (existing.trackNumber == null) {
      existing.trackNumber = parseTrackNumber(file);
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

// v2: caps creator list length and cleans/truncates — long unbroken
// creator strings were part of the "album loading too wide" issue.
function creatorName(meta) {
  const c = meta?.metadata?.creator;
  if (!c) return "Unknown";
  const arr = Array.isArray(c) ? c : [c];
  const names = arr.map(String).map((s) => s.trim()).filter(Boolean);
  if (!names.length) return "Unknown";
  if (names.length > 3) return cleanText(`${names.slice(0, 3).join(", ")} & others`, 80);
  return cleanText(names.join(", "), 80);
}
function albumArtwork(identifier) {
  return `${ARCHIVE_THUMB_URL}/${encodeURIComponent(identifier)}`;
}
function downloadUrl(identifier, filename) {
  return `${ARCHIVE_DOWNLOAD_URL}/${encodeURIComponent(identifier)}/${encodeURIComponent(filename)}`;
}
function findPairedVideo(files, baseKey) {
  return (files || []).find((f) => VIDEO_EXT.test(f.name || "") && normalizeBaseName(f.name) === baseKey) || null;
}

function buildTrackFromGroup(identifier, group, meta, includeVideo, allFiles) {
  const file = group.file;
  const track = {
    id: b64urlEncode({ i: identifier, f: file.name }),
    title: fileTitle(file),
    artist: creatorName(meta),
    album: cleanText(meta?.metadata?.title || identifier, 100),
    duration: parseDurationSeconds(file) ?? 0, // v2: always numeric, never undefined
    artworkURL: albumArtwork(identifier),
    format: mapFormatField(file),
    streamURL: downloadUrl(identifier, file.name),
  };
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
    version: "2.0.0",
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
        help: "Some archive.org recordings include a matching video file alongside the audio (e.g. multi-camera concert uploads). When on, Eclipse shows a video toggle for those tracks.",
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

  let query = `(${luceneEscape(q)}) AND mediatype:(audio)`;
  if (catDef.collectionFilter) query += ` AND ${catDef.collectionFilter}`;

  // v2: no forced sort — let archive.org rank by relevance for text queries.
  const rawDocs = await archiveSearch({ q: query, rows: 24, sort: null });
  const docs = boostExactMatches(rawDocs, q);

  const albums = docs.map((d) => ({
    id: d.identifier,
    title: cleanText(d.title || d.identifier, 100),
    artist: cleanText(Array.isArray(d.creator) ? d.creator.join(", ") : d.creator || "Unknown", 80),
    artworkURL: albumArtwork(d.identifier),
    year: (d.date || "").slice(0, 4) || undefined,
  }));

  // v2: fully parallel for this small top-N set — no artificial queueing.
  const topDocs = docs.slice(0, SEARCH_ENRICH_COUNT);
  const metas = await Promise.all(topDocs.map((d) => archiveMetadata(d.identifier, METADATA_TIMEOUT_FAST_MS)));
  const tracks = [];
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 6);
    for (const g of groups) tracks.push(buildTrackFromGroup(topDocs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  const creatorSet = new Map();
  for (const d of docs) {
    const names = Array.isArray(d.creator) ? d.creator : d.creator ? [d.creator] : [];
    for (const name of names) {
      const key = name.trim();
      if (key && !creatorSet.has(key)) creatorSet.set(key, d);
    }
  }
  const artists = [...creatorSet.entries()].slice(0, 10).map(([name, d]) => ({
    id: b64urlEncode({ c: name }),
    name: cleanText(name, 80),
    artworkURL: albumArtwork(d.identifier),
  }));

  return jsonResp({ tracks, albums, artists, playlists: [] }, 200, 120);
}

async function streamHandler(idParam) {
  let identifier, filename;
  try {
    ({ i: identifier, f: filename } = b64urlDecode(idParam));
  } catch (e) {
    return jsonResp({ error: "Invalid track id" }, 400);
  }
  if (!identifier || !filename) return jsonResp({ error: "Invalid track id" }, 400);
  const url = downloadUrl(identifier, filename);
  const format = mapFormatField({ name: filename });
  const quality = /flac|wav|alac/i.test(filename) ? "Lossless" : "Standard";
  return jsonResp({ url, format, quality });
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
      groups: groups.map((g) => ({ file: g.file.name, format: g.file.format, score: g.score, trackNumber: g.trackNumber })),
    }, 200, 0);
  }

  const tracks = groups.map((g) => buildTrackFromGroup(identifier, g, meta, includeVideo, meta.files));

  return jsonResp({
    id: identifier,
    title: cleanText(meta.metadata?.title || identifier, 100),
    artist: creatorName(meta),
    artworkURL: albumArtwork(identifier),
    year: (meta.metadata?.date || "").slice(0, 4) || undefined,
    description: meta.metadata?.description ? cleanText(stripHtml(meta.metadata.description), 300) : undefined,
    trackCount: tracks.length,
    tracks,
  }, 200, 300);
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

  const docs = await archiveSearch({ q: `creator:("${luceneEscape(creator)}") AND mediatype:(audio)`, rows: 40, sort: "downloads desc" });
  const albums = docs.map((d) => ({
    id: d.identifier,
    title: cleanText(d.title || d.identifier, 100),
    artist: cleanText(creator, 80),
    artworkURL: albumArtwork(d.identifier),
    year: (d.date || "").slice(0, 4) || undefined,
  }));

  const topDocs = docs.slice(0, ARTIST_TOP_TRACK_ITEMS);
  const metas = await Promise.all(topDocs.map((d) => archiveMetadata(d.identifier, METADATA_TIMEOUT_FAST_MS)));
  const topTracks = [];
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 3);
    for (const g of groups) topTracks.push(buildTrackFromGroup(topDocs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  return jsonResp({
    id: idParam,
    name: cleanText(creator, 80),
    artworkURL: docs[0] ? albumArtwork(docs[0].identifier) : undefined,
    topTracks,
    albums,
  }, 200, 300);
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

  return jsonResp({
    id: identifier,
    title: cleanText(collectionMeta?.metadata?.title || identifier, 100),
    description: collectionMeta?.metadata?.description ? cleanText(stripHtml(collectionMeta.metadata.description), 300) : undefined,
    artworkURL: albumArtwork(identifier),
    creator: cName !== "Unknown" ? cName : undefined,
    tracks,
  }, 200, 300);
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
