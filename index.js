/**
 * Internet Archive Addon — Cloudflare Worker (for Eclipse Music)
 *
 * Searches, browses, and streams audio directly from archive.org:
 * music, live concerts (etree), audiobooks (LibriVox), old-time radio,
 * podcasts — anything tagged mediatype:audio on the Internet Archive.
 *
 * No auth, no API keys, no secrets. archive.org is fully public.
 *
 * ── Mapping onto archive.org ─────────────────────────────────────────────
 * - "album"    -> an archive.org "item" (identifier), which is usually a
 *                 full concert/album/audiobook upload containing multiple
 *                 audio files.
 * - "track"    -> one audio file inside an item's file list. When an item
 *                 has multiple renditions of the same recording (e.g. a
 *                 FLAC "source" plus a derivative VBR MP3), they're grouped
 *                 and the best one (by format score) is picked.
 * - "artist"   -> archive.org's `creator` metadata field. IA has no real
 *                 artist pages, so this is a best-effort aggregation of
 *                 items sharing a creator name.
 * - "playlist" -> an archive.org "collection". /playlist/{collectionId}
 *                 lists audio items belonging to that collection.
 *
 * ── Why streamURL is used everywhere ─────────────────────────────────────
 * archive.org download links (https://archive.org/download/{id}/{file})
 * never expire and need no signing — so every track object includes a
 * direct `streamURL`. Per Eclipse's addon spec, that means Eclipse skips
 * calling /stream entirely for these, and saved/library tracks keep
 * playing even if this worker is ever offline. /stream/{id} is still
 * implemented (it's a required endpoint) as a fallback.
 *
 * ── contentType note ──────────────────────────────────────────────────────
 * Eclipse's manifest only supports ONE contentType per addon ("music",
 * "audiobook", or "podcast") — it's not per-track. Since this addon mixes
 * music, audiobooks, and radio, contentType is set to "music" (the
 * standard player). Audiobook-specific UI (chapters, speed control, sleep
 * timer) won't activate under this addon; split into a second
 * audiobook-mode addon later if that matters to you.
 *
 * v1 — initial build.
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

const FETCH_TIMEOUT_MS = 8000;
const SEARCH_ENRICH_COUNT = 6; // how many top search hits get a real track listing
const ARTIST_TOP_TRACK_ITEMS = 5;
const PLAYLIST_MAX_ITEMS = 30;
const BATCH_CONCURRENCY = 5;

const METADATA_CACHE_TTL_MS = 10 * 60 * 1000;
const metadataCache = new Map(); // identifier -> { data, ts }

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

// Compact, URL-safe composite IDs (identifier + filename, or creator name)
// so track/artist ids survive round-tripping through Eclipse's URL paths
// without needing a delimiter that could collide with real filenames.
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
async function archiveSearch({ q, rows = 25, page = 1, sort = "downloads desc", fields = ["identifier", "title", "creator", "date", "downloads", "mediatype", "collection"] }) {
  const url = new URL(ARCHIVE_SEARCH_URL);
  url.searchParams.set("q", q);
  url.searchParams.set("rows", String(rows));
  url.searchParams.set("page", String(page));
  url.searchParams.set("output", "json");
  url.searchParams.append("sort[]", sort);
  for (const f of fields) url.searchParams.append("fl[]", f);
  try {
    const r = await fetch(url.toString(), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return [];
    const d = await r.json();
    return d?.response?.docs || [];
  } catch (e) {
    return [];
  }
}

async function archiveMetadata(identifier) {
  const cached = metadataCache.get(identifier);
  if (cached && Date.now() - cached.ts < METADATA_CACHE_TTL_MS) return cached.data;
  try {
    const r = await fetch(`${ARCHIVE_METADATA_URL}/${encodeURIComponent(identifier)}`, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) return null;
    const d = await r.json();
    metadataCache.set(identifier, { data: d, ts: Date.now() });
    return d;
  } catch (e) {
    return null;
  }
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
  // preferLossless off: still rank sensibly, just don't force lossless to the top
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

function fileTitle(file) {
  if (file.title) return file.title;
  const cleaned = (file.name || "")
    .replace(/\.[a-z0-9]{2,5}$/i, "")
    .replace(/^\d{1,3}[\s._-]+/, "")
    .replace(/[_]+/g, " ")
    .trim();
  return cleaned || file.name || "Untitled";
}

// Groups multiple renditions of the same recording (e.g. FLAC + VBR MP3
// of the same song) into one logical track, keeping the best-scoring file.
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

function creatorName(meta) {
  const c = meta?.metadata?.creator;
  if (!c) return "Unknown";
  if (Array.isArray(c)) return c.join(", ");
  return String(c);
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
    album: meta?.metadata?.title || identifier,
    duration: parseDurationSeconds(file),
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
function manifest() {
  return {
    id: ADDON_ID,
    name: ADDON_NAME,
    version: "1.0.0",
    description: ADDON_DESC,
    icon: ADDON_ICON,
    resources: ["search", "stream", "catalog", "settings"],
    types: ["track", "album", "artist", "playlist"],
    contentType: "music",
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

function landingHTML() {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${ADDON_NAME} for Eclipse</title>
<style>
  body { background:#0a0a0a; color:#e8e8e8; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; display:flex; align-items:center; justify-content:center; min-height:100vh; margin:0; padding:24px; }
  .card { max-width:480px; background:#111; border:1px solid #222; border-radius:16px; padding:32px; }
  h1 { margin:0 0 8px; font-size:20px; }
  p { color:#999; font-size:14px; line-height:1.6; }
  code { background:#000; padding:2px 6px; border-radius:4px; color:#fff; }
</style>
</head>
<body>
<div class="card">
  <h1>${ADDON_NAME} for Eclipse</h1>
  <p>${ADDON_DESC}</p>
  <p>Install in Eclipse: Settings → Connections → Add Connection → Addon, then paste this worker's URL (with <code>/manifest.json</code>).</p>
</div>
</body>
</html>`;
}

// ─── Route handlers ─────────────────────────────────────────────────────────
async function searchHandler(u) {
  const q = (u.searchParams.get("q") || "").trim();
  if (!q) return jsonResp({ tracks: [], albums: [], artists: [], playlists: [] }, 200, 60);

  const preferLossless = u.searchParams.get("preferLossless") !== "false";
  const includeVideo = u.searchParams.get("includeVideo") === "true";

  const docs = await archiveSearch({ q: `(${luceneEscape(q)}) AND mediatype:(audio)`, rows: 24 });

  const albums = docs.map((d) => ({
    id: d.identifier,
    title: d.title || d.identifier,
    artist: Array.isArray(d.creator) ? d.creator.join(", ") : d.creator || "Unknown",
    artworkURL: albumArtwork(d.identifier),
    year: (d.date || "").slice(0, 4) || undefined,
  }));

  const topDocs = docs.slice(0, SEARCH_ENRICH_COUNT);
  const metas = await mapWithConcurrency(topDocs, BATCH_CONCURRENCY, (d) => archiveMetadata(d.identifier));
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
    name,
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

  const meta = await archiveMetadata(identifier);
  if (!meta || !Array.isArray(meta.files)) return jsonResp({ tracks: [], error: "Item not found on Internet Archive" }, 404);

  const groups = groupAudioFiles(meta.files, preferLossless);
  const tracks = groups.map((g) => buildTrackFromGroup(identifier, g, meta, includeVideo, meta.files));

  return jsonResp({
    id: identifier,
    title: meta.metadata?.title || identifier,
    artist: creatorName(meta),
    artworkURL: albumArtwork(identifier),
    year: (meta.metadata?.date || "").slice(0, 4) || undefined,
    description: meta.metadata?.description ? stripHtml(meta.metadata.description).slice(0, 2000) : undefined,
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

  const docs = await archiveSearch({ q: `creator:("${luceneEscape(creator)}") AND mediatype:(audio)`, rows: 40 });
  const albums = docs.map((d) => ({
    id: d.identifier,
    title: d.title || d.identifier,
    artist: creator,
    artworkURL: albumArtwork(d.identifier),
    year: (d.date || "").slice(0, 4) || undefined,
  }));

  const topDocs = docs.slice(0, ARTIST_TOP_TRACK_ITEMS);
  const metas = await mapWithConcurrency(topDocs, BATCH_CONCURRENCY, (d) => archiveMetadata(d.identifier));
  const topTracks = [];
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 3);
    for (const g of groups) topTracks.push(buildTrackFromGroup(topDocs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  return jsonResp({
    id: idParam,
    name: creator,
    artworkURL: docs[0] ? albumArtwork(docs[0].identifier) : undefined,
    topTracks,
    albums,
  }, 200, 300);
}

async function playlistHandler(identifier, u) {
  const preferLossless = u.searchParams.get("preferLossless") !== "false";
  const includeVideo = u.searchParams.get("includeVideo") === "true";

  const collectionMeta = await archiveMetadata(identifier);
  const docs = await archiveSearch({ q: `collection:(${identifier}) AND mediatype:(audio)`, rows: PLAYLIST_MAX_ITEMS });

  const metas = await mapWithConcurrency(docs, BATCH_CONCURRENCY, (d) => archiveMetadata(d.identifier));
  const tracks = [];
  metas.forEach((meta, idx) => {
    if (!meta || !Array.isArray(meta.files)) return;
    const groups = groupAudioFiles(meta.files, preferLossless).slice(0, 1); // one representative track per item
    for (const g of groups) tracks.push(buildTrackFromGroup(docs[idx].identifier, g, meta, includeVideo, meta.files));
  });

  const cName = collectionMeta ? creatorName(collectionMeta) : "Unknown";

  return jsonResp({
    id: identifier,
    title: collectionMeta?.metadata?.title || identifier,
    description: collectionMeta?.metadata?.description ? stripHtml(collectionMeta.metadata.description).slice(0, 2000) : undefined,
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
  const parts = u.pathname.split("/").filter(Boolean);

  if (!parts.length) return htmlResp(landingHTML());
  if (parts[0] === "manifest.json") return jsonResp(manifest(), 200, 3600);
  if (parts[0] === "search") return await searchHandler(u);
  if (parts[0] === "stream" && parts[1]) return await streamHandler(parts[1]);
  if (parts[0] === "album" && parts[1]) return await albumHandler(decodeURIComponent(parts[1]), u);
  if (parts[0] === "artist" && parts[1]) return await artistHandler(parts[1], u);
  if (parts[0] === "playlist" && parts[1]) return await playlistHandler(decodeURIComponent(parts[1]), u);

  return jsonResp({ error: "Not found" }, 404);
}
