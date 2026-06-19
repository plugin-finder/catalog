#!/usr/bin/env node
// Self-contained catalog generator for the plugin-finder/catalog repo.
// No dependencies beyond Node 20+ (global fetch). Rebuilds plugin-index.json
// from the GitHub sources listed in index-sources.json.
//
//   GITHUB_TOKEN=ghp_xxx node build-plugin-index.mjs
//
// Only repos/plugins with an EXPLICIT MIT license grant are included; plugins
// containing @no-localize are skipped (author opt-out). On a per-repo fetch failure the repo's existing
// entries are kept, so a transient outage never drops plugins.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'plugin-index.json');
const SOURCES = path.join(__dirname, 'index-sources.json');
const TOKEN = process.env.GITHUB_TOKEN || '';
const API = 'https://api.github.com';
const TAG_KEYWORDS = ['battle','map','menu','ui','event','message','audio','save','title','picture','animation','item','skill','actor','enemy','utility'];

const OPT_OUT_RE = /@no-?(?:locali[sz]e|translate)\b/i;
export function hasOptOutMarker(src) { return !!src && OPT_OUT_RE.test(src); }

export function splitRepoDir(repoDir) {
  const parts = (repoDir || '').split('-');
  if (parts.length < 2) return [];
  const out = [];
  for (let i = 1; i < parts.length; i++) out.push([parts.slice(0, i).join('-'), parts.slice(i).join('-')]);
  return out;
}

// Map a raw annotation-block locale code (e.g. '', 'ja', 'EN', 'zh', 'zh-TW')
// to an app-supported locale key so the catalog's per-language descriptions can
// be matched against the UI locale. The no-suffix default block ('') is treated
// as 'ja' when its text is Japanese, otherwise 'en'. Unknown codes are returned
// lowercased (never dropped).
// NOTE: keep in sync with mapBlockLocale in electron/src/core/lang.js — this
// file is intentionally dependency-free and cannot import from there.
const HAS_JP = /[぀-ヿ㐀-鿿]/; // hiragana, katakana, CJK ideographs
export function mapBlockLocale(code, text) {
  const low = (code || '').toLowerCase();
  if (!low) return HAS_JP.test(text || '') ? 'ja' : 'en';
  if (/^zh[-_](tw|hk|mo|hant)/.test(low) || low === 'zh-hant') return 'zh-TW';
  if (low.startsWith('zh')) return 'zh-CN';
  if (low.startsWith('pt')) return 'pt-BR';
  const prefix = low.split(/[-_]/)[0];
  const known = ['ja', 'en', 'ko', 'de', 'es', 'fr', 'it', 'pl', 'ru'];
  return known.includes(prefix) ? prefix : low;
}

// Minimal annotation read: scan /*: blocks and prefer the default/English one
// for the canonical `plugindesc`/`help`. `descriptions` additionally captures
// the @plugindesc of EVERY language block (keyed by mapped locale) so the app
// can show the description matching the user's display language.
// Lines may or may not carry the conventional leading ` * ` — the MZ
// PluginManager accepts bare `@tag` lines too (e.g. unagiootoro's plugins),
// so the tag regex treats the asterisk as optional.
export function extractMeta(src) {
  if (!src) return null;
  const norm = src.replace(/\r\n/g, '\n');
  const re = /\/\*:([\w-]*)[^\n]*\n([\s\S]*?)\*\//g;
  const blocks = [];
  let m;
  while ((m = re.exec(norm))) blocks.push({ locale: m[1] || '', body: m[2] });
  if (!blocks.length) return null;
  const tagFrom = (body, name) => {
    const mm = body.match(new RegExp('^\\s*\\*?\\s*@' + name + '\\s*(.*)$', 'mi'));
    return mm ? mm[1].trim() : '';
  };
  const pick = blocks.find(b => b.locale === '' || b.locale.toLowerCase() === 'en') || blocks[0];
  const body = pick.body;
  const descriptions = {};
  for (const b of blocks) {
    const d = tagFrom(b.body, 'plugindesc');
    if (!d) continue;
    const key = mapBlockLocale(b.locale, d);
    if (!descriptions[key]) descriptions[key] = d;
  }
  return { author: tagFrom(body, 'author'), plugindesc: tagFrom(body, 'plugindesc'), target: tagFrom(body, 'target'), help: body, descriptions };
}

export function detectTarget(meta, src) {
  const t = (meta.target || '').toUpperCase();
  if (t.includes('MZ') && t.includes('MV')) return 'MV/MZ';
  if (t.includes('MZ')) return 'MZ';
  if (t.includes('MV')) return 'MV';
  if (/PluginManager\.registerCommand/.test(src || '')) return 'MZ';
  // No @target and no MZ-only API: MZ plugins almost always declare @target,
  // so treat the remainder as MV (MV-era plugins omit @target).
  return 'MV';
}

export function deriveTags(text) {
  const hay = (text || '').toLowerCase();
  return TAG_KEYWORDS.filter(t => hay.includes(t));
}

// Deployed-game / demo detector. A tree that ships the RPG Maker runtime
// (js/rpg_core.js = MV, js/rmmz_core.js = MZ), the deployed plugin manifest
// (js/plugins.js), or game data (data/System.json) is a game project, not a
// plugin collection: its js/plugins/ folder holds COPIES of third-party
// plugins (often outdated, attributed to the wrong repo). Automatically
// discovered game repos are skipped entirely; manually seeded repos[]/
// repoDirs[] are curated by a human and never skipped. A discovered repo that
// is wrongly skipped (e.g. a plugin bundled with a demo) can be force-included
// by adding it to repos[].
export function isGameProjectTree(paths) {
  return (paths || []).some(p =>
    /(^|\/)js\/(rmmz_core|rpg_core)\.js$/i.test(p) ||
    /(^|\/)js\/plugins\.js$/i.test(p) ||
    /(^|\/)data\/System\.json$/i.test(p));
}

// Detect an explicit MIT declaration in the plugin's own header. Many authors
// state the license in the file even when the repository has no LICENSE file
// (common for Japanese plugin authors). Returns 'MIT' / null.
//
// Only an explicit MIT grant counts. Anything else — including "Unlicensed",
// "public domain", or the Unlicense — is treated as all-rights-reserved and
// excluded: a file without a clear, recognized license grant must not be
// redistributed.
export function detectLicenseFromSource(src) {
  if (!src) return null;
  const head = src.slice(0, 8000);
  if (/MIT\s+Licen[sc]e|MITライセンス|releas\w*\s+under\s+(the\s+)?MIT|under\s+the\s+MIT|@licen[sc]e\s+MIT|licen[sc]e[:：]?\s*MIT|ライセンス[:：]?\s*MIT/i.test(head)) return 'MIT';
  return null;
}

export function pluginSourceToEntry(src, { owner, repo, relativePath, license, branch }) {
  if (hasOptOutMarker(src)) return null;
  const meta = extractMeta(src);
  if (!meta) return null;
  if (!meta.plugindesc && !meta.author) return null;
  // Attach the per-language map only when 2+ languages are present; otherwise
  // the app falls back to `description` and the field would just bloat the index.
  const multiLang = meta.descriptions && Object.keys(meta.descriptions).length >= 2;
  return {
    filename: relativePath.split('/').pop(),
    author: meta.author,
    repoDir: `${owner}-${repo}`,
    // repoDir joins owner and repo with '-', which is ambiguous to split back
    // when the owner itself contains a dash (e.g. "pota-gon" → repoDir
    // "pota-gon-RPGMakerMZ" → wrong "pota/gon-RPGMakerMZ"). Emit an explicit
    // unambiguous slug in that case; the app prefers it over splitRepoDir.
    ...(owner.includes('-') ? { repoSlug: `${owner}/${repo}` } : {}),
    relativePath,
    description: meta.plugindesc,
    ...(multiLang ? { descriptions: meta.descriptions } : {}),
    target: detectTarget(meta, src),
    tags: deriveTags(`${relativePath} ${meta.plugindesc} ${meta.help}`),
    license,
    // Only present for branch-pinned scans ("owner/repo#branch" sources):
    // marks that the file lives on a non-default branch.
    ...(branch ? { branch } : {}),
  };
}

// A branch-pinned scan can revisit files that also exist on the default
// branch. Keep the default-branch entry in that case: the app downloads via
// HEAD (= the default branch) first, so that is the version users actually
// receive; a pinned-branch duplicate would silently resolve to the wrong file.
export function dedupeEntriesPreferDefault(entries) {
  const byFile = new Map();
  for (const e of entries) {
    const k = `${e.repoDir}\x00${e.relativePath}`;
    const prev = byFile.get(k);
    if (!prev || (prev.branch && !e.branch)) byFile.set(k, e);
  }
  return [...byFile.values()];
}

// Cross-repo de-duplication. The same plugin often appears in several repos:
// mirror/translation accounts (e.g. munokura re-hosting DarkPlasma/Yana),
// copies sitting in other authors' collections, or the js/plugins/ folder of a
// game project. Collapse entries that share filename + author + target down to
// a single source repo, preferring the canonical one:
//   1. a seeded/curated repo over an auto-discovered one,
//   2. then the repo hosting the fewest distinct authors (an author's own repo
//      over a many-author aggregator/mirror),
//   3. then the shortest / lexically-first repoDir for determinism.
// All of the winning repo's matching entries are kept, so an author's own
// MV/MZ or versioned variants survive; only OTHER repos' copies drop. Entries
// with no author are never merged (their identity can't be confirmed). `target`
// is part of the key so an MV and an MZ build of the same file are not merged.
export function dedupeAcrossReposByPlugin(entries) {
  const authorsByRepo = new Map();          // repoDir -> Set(author)
  for (const e of entries) {
    if (!authorsByRepo.has(e.repoDir)) authorsByRepo.set(e.repoDir, new Set());
    authorsByRepo.get(e.repoDir).add((e.author || '').trim());
  }
  const repoRank = (rd, sample) => [
    sample._origin === 'seed' ? 0 : 1,
    authorsByRepo.get(rd).size,
    rd.length,
    rd,
  ];
  const groups = new Map();                 // key -> entries[]
  const keep = [];
  for (const e of entries) {
    const author = (e.author || '').trim();
    if (!author) { keep.push(e); continue; }   // unkeyed: always kept
    const k = `${e.filename.toLowerCase()} ${author} ${e.target || ''}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }
  const less = (a, b) => { for (let i = 0; i < a.length; i++) { if (a[i] < b[i]) return true; if (a[i] > b[i]) return false; } return false; };
  for (const es of groups.values()) {
    const repos = [...new Set(es.map(e => e.repoDir))];
    if (repos.length < 2) { keep.push(...es); continue; }
    const sample = {};                       // one entry per repo (carries _origin)
    for (const e of es) if (!sample[e.repoDir]) sample[e.repoDir] = e;
    let winner = repos[0];
    for (const rd of repos) if (less(repoRank(rd, sample[rd]), repoRank(winner, sample[winner]))) winner = rd;
    for (const e of es) if (e.repoDir === winner) keep.push(e);
  }
  return keep;
}

function ghHeaders() {
  const h = { 'Accept': 'application/vnd.github+json', 'User-Agent': 'plugin-finder-catalog' };
  if (TOKEN) h.Authorization = `Bearer ${TOKEN}`;
  return h;
}
async function ghJson(url) {
  const r = await fetch(url, { headers: ghHeaders() });
  if (r.status === 404) return null;
  if (r.status === 403 && r.headers.get('x-ratelimit-remaining') === '0') {
    const reset = Number(r.headers.get('x-ratelimit-reset') || 0) * 1000;
    await new Promise(s => setTimeout(s, Math.max(0, reset - Date.now()) + 1000));
    return ghJson(url);
  }
  if (!r.ok) throw new Error(`GitHub ${r.status} ${url}`);
  return r.json();
}
async function ghRaw(owner, repo, branch, p) {
  const r = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${p}`);
  if (!r.ok) throw new Error(`raw ${r.status} ${p}`);
  return r.text();
}
// "owner/repo" or "owner/repo#branch" (the latter pins the scan to a branch
// other than the default — for repos that publish plugins on a side branch,
// e.g. triacontane's master = the MV line next to the mz_master default).
// NOTE: the app's downloader currently tries HEAD/master/main only, so pin
// only branches it can reach; e.g. a "release" branch needs app support first.
export async function resolveRepo(spec) {
  const hash = spec.indexOf('#');
  const repoSpec = hash < 0 ? spec : spec.slice(0, hash);
  const branch = hash < 0 ? '' : spec.slice(hash + 1);
  if (repoSpec.includes('/')) {
    const [owner, repo] = repoSpec.split('/');
    return branch ? { owner, repo, branch } : { owner, repo };
  }
  for (const [owner, repo] of splitRepoDir(repoSpec)) {
    const info = await ghJson(`${API}/repos/${owner}/${repo}`);
    if (info && info.full_name) return { owner, repo };
  }
  return null;
}
async function listUserRepos(user) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const repos = await ghJson(`${API}/users/${user}/repos?per_page=100&page=${page}`);
    if (!repos || repos.length === 0) break;
    out.push(...repos.map(r => ({ owner: user, repo: r.name })));
    if (repos.length < 100) break;
  }
  return out;
}
async function listJsFiles(owner, repo, branch) {
  const tree = await ghJson(`${API}/repos/${owner}/${repo}/git/trees/${branch}?recursive=1`);
  if (!tree || !Array.isArray(tree.tree)) return [];
  return tree.tree.filter(n => n.type === 'blob' && /\.js$/i.test(n.path) && !/\.min\.js$/i.test(n.path)).map(n => n.path);
}

// Optional `searchQueries` in index-sources.json: each query runs against the
// GitHub repository search API and matching public repos join the scan list,
// so new plugin repos are picked up automatically without manual seeding.
// Discovery only adds repos whose SPDX license is already allowed (an explicit
// LICENSE file); header-only MIT repos can still be seeded via repos[]/users[].
async function discoverRepos(queries, allowed, perQueryPages = 3) {
  const out = [];
  for (const q of queries) {
    for (let page = 1; page <= perQueryPages; page++) {
      const r = await ghJson(`${API}/search/repositories?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      if (!r || !Array.isArray(r.items) || r.items.length === 0) break;
      for (const it of r.items) {
        if (it.fork || it.archived) continue;
        const spdx = it.license && it.license.spdx_id;
        if (spdx && allowed.has(spdx)) out.push({ owner: it.owner.login, repo: it.name, origin: 'auto' });
      }
      if (r.items.length < 100) break;
    }
  }
  return out;
}

// Optional `codeSearchQueries`: GitHub CODE search over the plugin annotations
// themselves (e.g. '"@target MZ" extension:js'). Language-independent and
// metadata-independent: it finds plugin repos that have no description/topics,
// and repos whose MIT grant exists only in the plugin headers — which
// repository search can never license-filter. Hits are mapped to their parent
// repos; the normal license gate (repo SPDX or per-file header declaration)
// still applies downstream, as does the deployed-game skip. The code-search
// API requires auth and has a strict secondary rate limit (~10 req/min), so
// requests are spaced out.
async function discoverReposFromCode(queries, perQueryPages = 3) {
  if (!TOKEN) { console.warn('[discover:code] skipped — GITHUB_TOKEN required for code search'); return []; }
  const out = [];
  for (const q of queries) {
    for (let page = 1; page <= perQueryPages; page++) {
      await new Promise(s => setTimeout(s, 6500)); // stay under the code-search rate limit
      const r = await ghJson(`${API}/search/code?q=${encodeURIComponent(q)}&per_page=100&page=${page}`);
      if (!r || !Array.isArray(r.items) || r.items.length === 0) break;
      for (const it of r.items) {
        const repo = it.repository;
        if (!repo || repo.fork || repo.archived || repo.private) continue;
        out.push({ owner: repo.owner.login, repo: repo.name, origin: 'auto' });
      }
      if (r.items.length < 100) break;
    }
  }
  return out;
}

function dedupeRepos(repos) {
  const seen = new Set();
  return repos.filter(r => {
    const k = `${r.owner}/${r.repo}#${r.branch || ''}`.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

async function main() {
  if (!TOKEN) console.warn('[warn] GITHUB_TOKEN not set — API limited to 60 req/h.');
  const cfg = JSON.parse(fs.readFileSync(SOURCES, 'utf8'));
  const allowed = new Set(cfg.allowedLicenses || ['MIT']);
  const existing = fs.existsSync(OUT) ? JSON.parse(fs.readFileSync(OUT, 'utf8')) : [];
  const byRepoDir = {};
  for (const e of existing) { (byRepoDir[e.repoDir] || (byRepoDir[e.repoDir] = [])).push(e); }

  const specs = [...(cfg.repos || []), ...(cfg.repoDirs || [])];
  const repos = [];
  for (const spec of specs) { const r = await resolveRepo(spec); if (r) repos.push({ ...r, origin: 'seed' }); else console.warn('[skip] cannot resolve ' + spec); }
  for (const user of cfg.users || []) repos.push(...(await listUserRepos(user)).map(r => ({ ...r, origin: 'auto' })));
  // Discovery failures must not fail the whole run (the seeded repos still
  // rebuild); they are logged so a silent zero-contribution is visible.
  if ((cfg.searchQueries || []).length > 0) {
    try {
      const found = await discoverRepos(cfg.searchQueries, allowed);
      console.log(`[discover] ${found.length} candidate repo(s) from ${cfg.searchQueries.length} search query(ies)`);
      repos.push(...found);
    } catch (e) { console.warn(`[discover] repository search failed: ${e.message}`); }
  }
  if ((cfg.codeSearchQueries || []).length > 0) {
    try {
      const found = await discoverReposFromCode(cfg.codeSearchQueries);
      console.log(`[discover:code] ${found.length} candidate repo(s) from ${cfg.codeSearchQueries.length} code query(ies)`);
      repos.push(...found);
    } catch (e) { console.warn(`[discover:code] code search failed: ${e.message}`); }
  }
  const uniqueRepos = dedupeRepos(repos);

  // Repos a human has explicitly excluded (deployed games, demos, unwanted
  // mirrors). Accept either "owner/repo" or the repoDir "owner-repo" form.
  const excludeSet = new Set((cfg.excludeRepos || []).map(s => s.includes('/') ? s.replace('/', '-') : s));

  const result = [];
  for (const { owner, repo, origin, branch: pinnedBranch } of uniqueRepos) {
    const repoDir = `${owner}-${repo}`;
    const label = pinnedBranch ? `${repoDir}#${pinnedBranch}` : repoDir;
    if (excludeSet.has(repoDir)) { console.log(`[exclude] ${repoDir}: in excludeRepos`); continue; }
    try {
      const info = await ghJson(`${API}/repos/${owner}/${repo}`);
      const repoSpdx = (info && info.license && info.license.spdx_id) || '';
      const branch = pinnedBranch || info.default_branch || 'main';
      const files = await listJsFiles(owner, repo, branch);
      if (origin !== 'seed' && isGameProjectTree(files)) {
        console.log(`[game] ${repoDir}: deployed game project — skipped`);
        continue;
      }
      let kept = 0;
      for (const p of files) {
        try {
          const src = await ghRaw(owner, repo, branch, p);
          // Trust the repo SPDX when it is an allowed license; otherwise fall back
          // to a license declared in the plugin's own header (so repos without
          // a LICENSE file but with MIT-licensed plugins are still included).
          const license = allowed.has(repoSpdx) ? repoSpdx : detectLicenseFromSource(src);
          if (!license || !allowed.has(license)) continue;
          const entry = pluginSourceToEntry(src, { owner, repo, relativePath: p, license, branch: pinnedBranch });
          if (entry) { entry._origin = origin; result.push(entry); kept++; }
        } catch (_) { /* skip file */ }
      }
      console.log(`[ok] ${label}: ${kept} plugin(s)`);
    } catch (e) {
      const fb = byRepoDir[repoDir] || [];
      result.push(...fb);
      console.warn(`[keep] ${label}: ${e.message}; kept ${fb.length}`);
    }
  }
  let entries = dedupeEntriesPreferDefault(result);
  const beforeCross = entries.length;
  entries = dedupeAcrossReposByPlugin(entries);
  console.log(`[dedup] cross-repo (mirrors/copies): ${beforeCross} → ${entries.length} (-${beforeCross - entries.length})`);
  entries = entries.map(({ _origin, ...e }) => e);   // drop transient build-only field
  entries.sort((a, b) => a.repoDir.localeCompare(b.repoDir) || a.relativePath.localeCompare(b.relativePath));
  console.log(`Total: ${entries.length} entries`);
  fs.writeFileSync(OUT, JSON.stringify(entries, null, 0) + '\n');
  console.log(`Wrote ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  main().catch(e => { console.error(e); process.exit(1); });
}
