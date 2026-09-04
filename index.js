/**
 * Internet Archive Addon — Cloudflare Worker (for Eclipse Music)
 *
 * v5 — ARTWORK SIZE, HUGE-ITEM PAGINATION, FLAC/MP3 GROUPING FIX:
 * - FIXED covers rendering huge/off-screen again: archive.org's
 *   /services/img/{id} endpoint does NOT always serve a proper small
 *   thumbnail — for any item that never had a derived thumbnail
 *   generated, it serves the ORIGINAL SOURCE IMAGE directly, which can
 *   be a multi-megapixel raw scan. Every artwork URL now requests an
 *   explicit `?w=500` (archive.org honors width-constrained thumbnail
 *   requests), so even un-derived items get a bounded-size image instead
 *   of whatever raw file happens to be attached.
 * - FIXED "some albums not loading" / "artist pages huge, completely off
 *   screen": some archive.org items (78rpm compilations, old-time radio
 *   box sets, etc.) contain hundreds to thousands of audio files. album/
 *   artist/playlist responses are now capped at a sane max track count
 *   (ALBUM_TRACK_LIMIT) with a `truncated`/`totalTracks` hint, instead of
 *   returning every single file — that's what was producing enormous
 *   payloads that either timed out entirely or rendered as absurdly long
 *   pages.
 * - FIXED "quality only ever shows mp3, never flac": the file-grouping
 *   logic that merges different renditions of the same track (so the
 *   best format wins) was comparing cleaned filenames directly, but
 *   archive.org's auto-derived MP3s commonly append a bitrate/encoding
 *   suffix the source file doesn't have (e.g. "trackname.flac" vs
 *   "trackname_vbr.mp3" or "trackname_64kb.mp3") — that suffix made them
 *   normalize to DIFFERENT keys, so the FLAC and MP3 were never actually
 *   compared against each other for the same logical track, and
 *   whichever one simply appeared "good enough" on its own could end up
 *   picked. normalizeBaseName now also strips common bitrate/encoding
 *   suffixes (_64kb, _vbr, _128kbps, etc.) before grouping, so FLAC vs
 *   MP3 renditions of the same recording are correctly recognized as
 *   the same track and the real winner is chosen by score.
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
const THUMB_WIDTH = 500; // v5: bounds archive.org's thumbnail service to a sane size

const METADATA_TIMEOUT_FULL_MS = 15000;
const METADATA_TIMEOUT_FAST_MS = 4000;
const SEARCH_TIMEOUT_MS = 6000;

const SEARCH_ENRICH_COUNT = 4;
const SEARCH_ALBUM_LIMIT = 20;
const SEARCH_ARTIST_LIMIT = 8;
const ARTIST_TOP_TRACK_ITEMS = 5;
const ARTIST_ALBUM_LIMIT = 24;
const PLAYLIST_MAX_ITEMS = 30;
const PLAYLIST_CONCURRENCY = 6;
const ALBUM_TRACK_LIMIT = 150; // v5: caps huge multi-hundred-file items from blowing out album pages

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

function buildArtistList(docs, rawQuery, limit) {
  const q = rawQuery.trim().toLowerCase();
  const exact = new Map();
  const partial = new Map();
  for (const d of docs) {
    const names = Array.isArray(d.creator) ? d.creator : d.creator ? [d.creator] : [];
    for (const name of names) {
      const key = name.trim();
      if (!key) continue;
      const lower = key.toLowerCase();
      if (lower === q) { if (!exact.has(key)) exact.set(key, d); }
      else if (lower.includes(q)) { if (!partial.has(key)) partial.set(key, d); }
    }
  }
  const orderedNames = [...exact.keys(), ...partial.keys()];
  const hasCloseMatch = orderedNames.some((n) => n.toLowerCase() === q);
  const finalNames = hasCloseMatch ? orderedNames : [rawQuery.trim(), ...orderedNames];
  const artworkFor = (name) => (exact.get(name) || partial.get(name) || docs[0]);
  return finalNames.slice(0, limit).map((name) => {
    const src = artworkFor(name);
    return {
      id: b64urlEncode({ c: name }),
      name: cleanText(name, 60),
      artworkURL: src ? albumArtwork(src.identifier) : undefined,
    };
  });
}

// ─── Audio file filtering, scoring, grouping ───────────────────────────────
const AUDIO_FORMAT_KEYWORDS = /flac|mp3|ogg|vorbis|\bwav\b|wave|ape|alac|aiff|shorten|\bshn\b|m4a|aac|opus/i;
const VIDEO_EXT = /\.(mp4|m4v|webm|mov)$/i;
const IMAGE_EXT = /\.(jpe?g|png|gif)$/i;

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
  if (f.includes("wave") || f.includes("wav") || name.endsWith(".wav")) return "flac";
  if (f.includes("m4a") || name.endsWith(".m4a")) return "m4a";
  if (f.includes("aac") || name.endsWith(".aac")) return "aac";
  if (f.includes("ogg") || f.includes("vorbis") || name.endsWith(".ogg")) return "aac";
  return "mp3";
}

// v5: FIXED the actual grouping bug. archive.org's auto-derived MP3s
// commonly carry a bitrate/encoding suffix the lossless source doesn't
// have (e.g. "song.flac" vs "song_vbr.mp3" or "song_64kb.mp3"). Those
// suffixes now get stripped BEFORE the extension/punctuation cleanup, so
// both renditions normalize to the same key and actually get compared
// against each other for best format — previously they silently became
// two unrelated "tracks" and the real FLAC could lose out or never even
// be seen as an alternative to the MP3.
const RENDITION_SUFFIX_RE = /[_\-\s]?(64kb?ps?|128kb?ps?|192kb?ps?|256kb?ps?|320kb?ps?|vbr|64k|128k|192k|256k|320k)$/i;
function normalizeBaseName(filename) {
  let base = String(filename || "").replace(/\.[a-z0-9]{2,5}$/i, "");
  let prev;
  do {
    prev = base;
    base = base.replace(RENDITION_SUFFIX_RE, "");
  } while (base !== prev);
  return base
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
    const key = normalizeBaseName(file.name);
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

// v5: width-constrained thumbnail request — bounds archive.org's
// fallback-to-original-image behavior for items with no derived
// thumbnail, which is what was rendering as huge/off-screen covers.
function albumArtwork(identifier) {
  return `${ARCHIVE_THUMB_URL}/${encodeURIComponent(identifier)}?w=${THUMB_WIDTH}`;
}
function resolveArtwork(identifier, files) {
  if (Array.isArray(files)) {
    const tagged = files.find((f) => f.name && IMAGE_EXT.test(f.name) && /item tile|item image|thumbnail/i.test(f.format || ""));
    if (tagged) return downloadUrl(identifier, tagged.name);
    const named = files.find((f) => f.name && IMAGE_EXT.test(f.name) && /cover|front|folder/i.test(f.name));
    if (named) return downloadUrl(identifier, named.name);
  }
  return albumArtwork(identifier);
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
    album: cleanText(meta?.metadata?.title || identifier, 90),
    duration: bestDurationForGroup(group),
    artworkURL: resolveArtwork(identifier, allFiles),
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
    version: "5.0.0",
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

  const creatorQuery = `creator:("${lucQ}") AND mediatype:(audio)${catFilter}`;
  const broadQuery = `(title:("${lucQ}") OR creator:("${lucQ}") OR description:("${lucQ}")) AND mediatype:(audio)${catFilter}`;

  const [creatorDocs, broadDocsRaw] = await Promise.all([
    archiveSearch({ q: creatorQuery, rows: 16, sort: "downloads desc" }),
    archiveSearch({ q: broadQuery, rows: 16, sort: null }),
  ]);
  const broadDocs = boostExactMatches(broadDocsRaw, q);
  const docs = dedupeDocsByIdentifier([creatorDocs, broadDocs]);

  const albums = docs.slice(0, SEARCH_ALBUM_LIMIT).map((d) => ({
    id: d.identifier,
    title: cleanText(d.title || d.identifier, 80),
    artist: cleanText(Array.isArray(d.creator) ? d.creator.join(", ") : d.creator || "Unknown", 60),
    artworkURL: albumArtwork(d.identifier),
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

  const artists = buildArtistList(docs, q, SEARCH_ARTIST_LIMIT);

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
      resolvedArtwork: resolveArtwork(identifier, meta.files),
      groups: groups.slice(0, 40).map((g) => ({
        file: g.file.name,
        format: g.file.format,
        score: g.score,
        trackNumber: g.trackNumber,
        chosenDuration: bestDurationForGroup(g),
        rawFileLength: g.file.length,
        memberFiles: g.members.map((m) => ({ name: m.name, format: m.format })),
      })),
    }, 200, 0);
  }

  const totalTracks = groups.length;
  const limitedGroups = groups.slice(0, ALBUM_TRACK_LIMIT);
  const tracks = limitedGroups.map((g) => buildTrackFromGroup(identifier, g, meta, includeVideo, meta.files));

  const result = {
    id: identifier,
    title: cleanText(meta.metadata?.title || identifier, 80),
    artist: creatorName(meta),
    artworkURL: resolveArtwork(identifier, meta.files),
    year: (meta.metadata?.date || "").slice(0, 4) || undefined,
    description: meta.metadata?.description ? cleanText(stripHtml(meta.metadata.description), 250) : undefined,
    trackCount: totalTracks,
    tracks,
  };
  if (totalTracks > ALBUM_TRACK_LIMIT) {
    result.truncated = true;
    result.totalTracks = totalTracks;
  }
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

  const [creatorDocsRaw, titleDocsRaw] = await Promise.all([
    archiveSearch({ q: `creator:("${lucC}") AND mediatype:(audio)`, rows: ARTIST_ALBUM_LIMIT, sort: "downloads desc" }),
    archiveSearch({ q: `title:("${lucC}") AND mediatype:(audio)`, rows: ARTIST_ALBUM_LIMIT, sort: "downloads desc" }),
  ]);
  const docs = dedupeDocsByIdentifier([creatorDocsRaw, titleDocsRaw]);

  const albums = docs.slice(0, ARTIST_ALBUM_LIMIT).map((d) => ({
    id: d.identifier,
    title: cleanText(d.title || d.identifier, 80),
    artist: cleanText(creator, 60),
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
    name: cleanText(creator, 60),
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
    title: cleanText(collectionMeta?.metadata?.title || identifier, 80),
    description: collectionMeta?.metadata?.description ? cleanText(stripHtml(collectionMeta.metadata.description), 250) : undefined,
    artworkURL: resolveArtwork(identifier, collectionMeta?.files),
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
