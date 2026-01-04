// server.js — stable, no API token, fixed structure, supports decimal chapters and genre pagination
// Deps: express, axios, cheerio
// npm i express axios cheerio

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');

const SITE_BASE = 'https://manhwa-tower.ir';
const CDN_SAMPLE_HOST = 'cdn.megaman-server.ir';
const MAX_PAGE_CHECK = 2000;

const app = express();
app.use(express.json({ limit: '200kb' })); // small protection for huge bodies

/* -------------------------
   Utilities
   ------------------------- */
function logErr(err, ctx = '') {
  console.error('[ERROR]', ctx, err && (err.stack || err.message || err));
}
function sanitizeSlug(slug) {
  if (!slug || typeof slug !== 'string') return null;
  const m = slug.match(/[A-Za-z0-9\-_]+/g);
  return m ? m.join('-') : null;
}
function parsePage(q, fallback = 1) {
  const p = parseInt(q || String(fallback), 10);
  if (isNaN(p) || p < 1) return fallback;
  return p;
}
function normalizeChapterParam(ch) {
  if (!ch) return null;
  return String(ch).replace(/[_\-]/g, '.').trim();
}

/* -------------------------
   Network helpers
   ------------------------- */
async function fetchHtml(url, timeout = 20000) {
  try {
    const r = await axios.get(url, {
      headers: { 'User-Agent': 'manga-proxy/1.0 (+https://example)' },
      timeout,
      maxRedirects: 5,
      validateStatus: s => s >= 200 && s < 400
    });
    return r.data;
  } catch (e) {
    const err = new Error(`fetchHtml failed for ${url}: ${e.message}`);
    err.original = e;
    throw err;
  }
}
async function existsUrl(url, timeout = 8000) {
  try {
    const r = await axios.head(url, { timeout, maxRedirects: 3, validateStatus: () => true });
    return r.status >= 200 && r.status < 300;
  } catch (e) {
    try {
      const r2 = await axios.get(url, { headers: { Range: 'bytes=0-32', 'User-Agent': 'manga-proxy/1.0' }, timeout, maxRedirects: 3, validateStatus: () => true });
      return r2.status >= 200 && r2.status < 300;
    } catch (_) {
      return false;
    }
  }
}

/* -------------------------
   Extractors
   ------------------------- */
async function extractHomePage(page = 1) {
  const url = page === 1 ? `${SITE_BASE}/page/1` : `${SITE_BASE}/page/${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = [];

  $('.manhwa-card').each((i, el) => {
    const a = $(el).find('a').first();
    const href = a.attr('href') || '';
    const link = href ? new URL(href, SITE_BASE).href : null;
    const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
    let cover = $(el).find('img').attr('src') || $(el).find('.cover img').attr('src') || null;
    if (cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;
    let slug = null;
    if (link) {
      try {
        const parts = new URL(link).pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
        slug = (idx >= 0 && parts.length > idx + 1) ? parts[idx + 1] : parts[parts.length - 1];
      } catch (e) {}
    }
    if (link && title) items.push({ slug, title, cover, link });
  });

  if (!items.length) {
    $('a[href*="/Manhwa/"]').each((i, el) => {
      const a = $(el);
      const href = a.attr('href');
      const title = a.attr('title') || a.text().trim();
      if (href && title) {
        const absolute = new URL(href, SITE_BASE).href;
        const parts = new URL(absolute).pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
        const slug = (idx >= 0 && parts.length > idx + 1) ? parts[idx + 1] : parts[parts.length - 1];
        const cover = a.find('img').attr('src') || null;
        const coverAbs = cover ? (cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href) : null;
        items.push({ slug, title, cover: coverAbs, link: absolute });
      }
    });
  }

  return items;
}

/* Genres: page extractor for a single gener.php page */
async function extractGenresPage(pageUrl = `${SITE_BASE}/gener.php`) {
  const html = await fetchHtml(pageUrl);
  const $ = cheerio.load(html);
  const genres = [];
  const anchors = $('a.genre-btn, a[href*="slug="], a[href*="gener.php"]');
  anchors.each((i, el) => {
    const href = $(el).attr('href') || '';
    const name = $(el).text().trim();
    if (!href || !name) return;
    try {
      const resolved = new URL(href, pageUrl);
      const slug = resolved.searchParams.get('slug') || (() => {
        const p = resolved.pathname.split('/').filter(Boolean);
        return p.length ? p[p.length - 1] : null;
      })();
      const link = resolved.href;
      if (slug) genres.push({ name, slug, link });
    } catch (e) {}
  });
  // dedupe by slug
  const map = new Map();
  for (const g of genres) if (g.slug && !map.has(g.slug)) map.set(g.slug, g);
  return Array.from(map.values());
}

/* aggregate multiple genre pages: we don't impose a hard ceiling here — caller decides pages param */
async function extractGenres(totalPages = 1) {
  const p = Math.max(1, Number(totalPages) || 1);
  const urls = [];
  for (let i = 1; i <= p; i++) {
    urls.push(`${SITE_BASE}/gener.php${i > 1 ? '?page=' + i : ''}`);
  }
  const settled = await Promise.allSettled(urls.map(u => extractGenresPage(u)));
  const merged = [];
  for (const s of settled) {
    if (s.status === 'fulfilled' && Array.isArray(s.value)) merged.push(...s.value);
    else logErr(s.status === 'rejected' ? s.reason : 'unknown', 'extractGenres');
  }
  const map = new Map();
  for (const g of merged) if (g.slug && !map.has(g.slug)) map.set(g.slug, g);
  return Array.from(map.values());
}

/* Manga detail extractor with decimal chapter support */
async function extractMangaDetail(slug) {
  const safeSlug = sanitizeSlug(slug) || slug;
  const url = `${SITE_BASE}/Manhwa/${safeSlug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('.display-5').first().text().trim() ||
                $('.display-6').first().text().trim() ||
                $('h1').first().text().trim() ||
                $('title').text().trim();

  let description = $('.kholase, .lead, .description, .post-content').first().text().trim() || '';
  if (!description) description = $('meta[name="description"]').attr('content') || '';

  const genres = [];
  $('.genre-tag, .genre-badge, a[href*="gener.php"]').each((i, el) => {
    const t = $(el).text().trim();
    if (t) genres.push(t);
  });

  let internalId = null;
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const m = href.match(/Chapter=([0-9]+(?:\.[0-9]+)?),([^&'"]+)/);
      if (m && m[2]) internalId = m[2];
    }
  });

  const chapters = [];
  $('.chapter-item a, .chapter-list a, .chapters a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (!href) return;
    const text = $(el).text().trim();
    const match = href.match(/Chapter=([0-9]+(?:\.[0-9]+)?),([^&'"]+)/);
    let chapterId = null;
    let chapterNum = null;
    if (match) {
      chapterId = match[1];
      chapterNum = Number(match[1]);
    } else {
      const m2 = text.match(/([0-9]+(?:\.[0-9]+)?)/);
      if (m2) {
        chapterId = m2[1];
        chapterNum = Number(m2[1]);
      }
    }
    try {
      const absolute = new URL(href, SITE_BASE).href;
      const titleFallback = text || (chapterId ? `Chapter ${chapterId}` : `#${i+1}`);
      chapters.push({ chapterId: chapterId || String(i+1), chapterNum: isFinite(chapterNum) ? chapterNum : null, title: titleFallback, link: absolute });
    } catch (e) {}
  });

  if (!chapters.length) {
    $('a').each((i, el) => {
      const href = $(el).attr('href') || '';
      if (href.includes('readerpage.php')) {
        const text = $(el).text().trim() || `#${i+1}`;
        const match = href.match(/Chapter=([0-9]+(?:\.[0-9]+)?),([^&'"]+)/);
        let chapterId = match ? match[1] : String(i+1);
        let chapterNum = match ? Number(match[1]) : null;
        try {
          const absolute = new URL(href, SITE_BASE).href;
          chapters.push({ chapterId, chapterNum: isFinite(chapterNum) ? chapterNum : null, title: text, link: absolute });
        } catch (e) {}
      }
    });
  }

  const uniq = {};
  chapters.forEach(c => { if (c.link) uniq[c.link] = c; });
  const list = Object.values(uniq).sort((a, b) => {
    const an = (typeof a.chapterNum === 'number') ? a.chapterNum : -Infinity;
    const bn = (typeof b.chapterNum === 'number') ? b.chapterNum : -Infinity;
    if (an !== bn) return bn - an;
    if (a.chapterId && b.chapterId) return (a.chapterId > b.chapterId) ? -1 : (a.chapterId < b.chapterId ? 1 : 0);
    return 0;
  });

  let cover = $('.cover img, .card-img-top, img').first().attr('src') || null;
  if (cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;

  return { slug: safeSlug, title, description, genres, internalId, cover, chapters: list, url };
}

/* Reader pages extraction with script fallback */
async function extractReaderPages(readerUrl) {
  const html = await fetchHtml(readerUrl);
  const $ = cheerio.load(html);
  const imgs = [];

  $('img.manhwa-image').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src');
    if (src) imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
  });

  if (!imgs.length) {
    $('.mhreader, .reader, .reader-content').find('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('srcset');
      if (src) {
        let chosen = src;
        if (chosen.includes(',')) chosen = chosen.split(',')[0].trim().split(' ')[0];
        imgs.push(chosen.startsWith('http') ? chosen : new URL(chosen, SITE_BASE).href);
      }
    });
  }

  if (!imgs.length) {
    const scripts = $('script').map((i, s) => $(s).html()).get().join('\n');
    const urlMatches = [...scripts.matchAll(/https?:\/\/[^'"\s]+?(?:webp|jpg|png)/g)].map(m => m[0]);
    if (urlMatches.length) imgs.push(...urlMatches);
  }

  return Array.from(new Set(imgs.map(u => u && (u.startsWith('http') ? u : new URL(u, SITE_BASE).href)).filter(Boolean)));
}

/* fallback CDN builder and page-count discovery (binary search) */
function buildFallbackPageUrl({ uid = '564', mangaName = '', chapter = '', page = 1 }) {
  const safe = encodeURIComponent(String(mangaName || '').replace(/\s+/g, '_'));
  return `https://${CDN_SAMPLE_HOST}/users/${uid}/${safe}/${chapter}/HD/${page}.webp`;
}
async function discoverPageCountByHead({ uid, mangaName, chapter }) {
  const maxCap = MAX_PAGE_CHECK;
  const url1 = buildFallbackPageUrl({ uid, mangaName, chapter, page: 1 });
  if (!await existsUrl(url1)) return null;

  let low = 1, high = 1;
  while (high < maxCap) {
    const u = buildFallbackPageUrl({ uid, mangaName, chapter, page: high });
    const ok = await existsUrl(u);
    if (!ok) break;
    low = high;
    high = high * 2;
    if (high > maxCap) { high = maxCap; break; }
  }

  if (await existsUrl(buildFallbackPageUrl({ uid, mangaName, chapter, page: high }))) return high;

  let left = low, right = high;
  while (left + 1 < right) {
    const mid = Math.floor((left + right) / 2);
    if (await existsUrl(buildFallbackPageUrl({ uid, mangaName, chapter, page: mid }))) left = mid;
    else right = mid;
  }
  return left;
}

/* -------------------------
   API endpoints
   ------------------------- */

app.get('/api/home', async (req, res) => {
  try {
    const page = parsePage(req.query.page || '1', 1);
    const items = await extractHomePage(page);
    return res.json({ ok: true, page, items });
  } catch (e) {
    logErr(e, '/api/home');
    return res.status(500).json({ ok: false, error: e.message || 'internal' });
  }
});

app.get('/api/genres', async (req, res) => {
  try {
    const pages = Math.max(1, Number(req.query.pages) || 1);
    const list = await extractGenres(pages);
    return res.json({ ok: true, pages, genres: list });
  } catch (e) {
    logErr(e, '/api/genres');
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/*
  GET /api/genre/:slug?page=1&pages=3
  page = start page, pages = how many consecutive pages to fetch (page=2&pages=3 => 2,3,4)
*/
app.get('/api/genre/:slug', async (req, res) => {
  try {
    const rawSlug = req.params.slug;
    const slug = sanitizeSlug(rawSlug) || rawSlug;
    const startPage = parsePage(req.query.page || '1', 1);
    const pages = Math.max(1, Number(req.query.pages) || 1);
    const pageNumbers = Array.from({ length: pages }, (_, i) => startPage + i);

    const fetches = pageNumbers.map(pn => (async () => {
      const url = `${SITE_BASE}/gener.php?slug=${encodeURIComponent(slug)}${pn > 1 ? '&page=' + pn : ''}`;
      const html = await fetchHtml(url);
      const $ = cheerio.load(html);
      const items = [];
      $('.manhwa-card').each((i, el) => {
        const a = $(el).find('a').first();
        const href = a.attr('href') || '';
        const link = href ? new URL(href, SITE_BASE).href : null;
        const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
        let cover = $(el).find('img').attr('src') || null;
        if (cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;
        let slugInfer = null;
        if (link) {
          const parts = new URL(link).pathname.split('/').filter(Boolean);
          const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
          slugInfer = (idx >= 0 && parts.length > idx + 1) ? parts[idx + 1] : parts[parts.length - 1];
        }
        if (link && title) items.push({ slug: slugInfer, title, cover, link });
      });
      return items;
    })());

    const settled = await Promise.allSettled(fetches);
    const merged = [];
    for (const s of settled) {
      if (s.status === 'fulfilled' && Array.isArray(s.value)) merged.push(...s.value);
      else logErr(s.status === 'rejected' ? s.reason : 'unknown', '/api/genre/:slug fetch');
    }

    const uniq = {};
    merged.forEach(it => { if (it.link) uniq[it.link] = it; });
    const items = Object.values(uniq);

    return res.json({ ok: true, genre: slug, startPage, pagesFetched: pageNumbers.length, items });
  } catch (e) {
    logErr(e, '/api/genre/:slug');
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* Manga detail: path and query supported */
app.get('/api/manga/:slug', async (req, res) => {
  try {
    const rawSlug = req.params.slug;
    const slug = sanitizeSlug(rawSlug) || rawSlug;
    const detail = await extractMangaDetail(slug);
    return res.json({ ok: true, manga: detail });
  } catch (e) {
    logErr(e, '/api/manga/:slug');
    return res.status(500).json({ ok: false, error: e.message });
  }
});
app.get('/api/manga', async (req, res) => {
  try {
    const rawSlug = req.query.slug;
    if (!rawSlug) return res.status(400).json({ ok: false, error: 'missing slug query' });
    const slug = sanitizeSlug(rawSlug) || rawSlug;
    const detail = await extractMangaDetail(slug);
    return res.json({ ok: true, manga: detail });
  } catch (e) {
    logErr(e, '/api/manga(query)');
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* Reader endpoints (both path and query). chapter accepts "1", "1.34", "1_34" */
app.get('/api/reader/:slug/:chapter', async (req, res) => {
  const q = { slug: req.params.slug, chapter: req.params.chapter };
  return handleReaderQuery(q, res);
});
app.get('/api/reader', async (req, res) => {
  return handleReaderQuery(req.query, res);
});

async function handleReaderQuery(query, res) {
  try {
    const rawSlug = query.slug;
    const rawChapter = query.chapter;
    if (!rawSlug || !rawChapter) return res.status(400).json({ ok: false, error: 'slug and chapter required' });

    const slug = sanitizeSlug(rawSlug) || rawSlug;
    const chapterParam = normalizeChapterParam(rawChapter);

    const manga = await extractMangaDetail(slug);

    let chapterLink = null;
    let matchedChapter = null;
    if (manga.chapters && manga.chapters.length) {
      matchedChapter = manga.chapters.find(c => String(c.chapterId) === chapterParam);
      if (!matchedChapter) {
        const n = Number(chapterParam);
        if (!Number.isNaN(n)) matchedChapter = manga.chapters.find(c => typeof c.chapterNum === 'number' && Math.abs(c.chapterNum - n) < 1e-6);
      }
      if (!matchedChapter) matchedChapter = manga.chapters.find(c => c.title && c.title.includes(chapterParam));
      if (matchedChapter) chapterLink = matchedChapter.link;
    }

    if (chapterLink) {
      const pages = await extractReaderPages(chapterLink);
      if (pages && pages.length) return res.json({ ok: true, method: 'explicit', pages, pageCount: pages.length, matchedChapter });
    }

    const uid = manga.internalId || null;
    const mangaName = manga.title || slug;
    if (uid) {
      const pageCount = await discoverPageCountByHead({ uid, mangaName, chapter: chapterParam }).catch(()=>null);
      if (pageCount && pageCount > 0) {
        const pages = [];
        for (let i = 1; i <= pageCount; i++) pages.push(buildFallbackPageUrl({ uid, mangaName, chapter: chapterParam, page: i }));
        return res.json({ ok: true, method: 'fallback-discovered', pages, pageCount, matchedChapter: matchedChapter || null });
      } else {
        const guessed = [];
        const guessCount = 25;
        for (let i = 1; i <= guessCount; i++) guessed.push(buildFallbackPageUrl({ uid, mangaName, chapter: chapterParam, page: i }));
        return res.json({ ok: true, method: 'fallback-guess', pages: guessed, note: 'could not discover exact pageCount', matchedChapter: matchedChapter || null });
      }
    }

    return res.status(422).json({ ok: false, error: 'Could not extract pages. Ensure slug correct or site uses JS-heavy reader.' });
  } catch (e) {
    logErr(e, '/api/reader');
    return res.status(500).json({ ok: false, error: e.message });
  }
}

/* Health + root */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));
app.get('/', (req, res) => {
  res.type('html').send(`<html><body style="font-family:Arial"><h3>Manga API</h3>
  <p>Examples:</p>
  <ul>
    <li>/api/manga/Death_is_the_only_ending_for_a_villainess</li>
    <li>/api/reader?slug=Death_is_the_only_ending_for_a_villainess&chapter=1.34</li>
    <li>/api/genre/action?page=1&pages=3</li>
  </ul></body></html>`);
});

/* Start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server listening on ${PORT}`));
