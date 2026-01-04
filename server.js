// app.js — single-file, no server-side cache, with genre endpoint and robust page-count detection
// deps: express, axios, cheerio, node-cron, murmurhash3js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const murmur = require('murmurhash3js'); // used only for optional hashing (not for caching here)
const path = require('path');

const SITE_BASE = 'https://manhwa-tower.ir';
const CDN_SAMPLE_HOST = 'cdn.megaman-server.ir'; // sample CDN observed; used for fallback pattern detection
const MAX_PAGE_CHECK = 2000; // safety cap for page discovery

const app = express();
app.use(express.json());

/* -------------------------
   Basic HTML fetcher (server-side)
   ------------------------- */
async function fetchHtml(url, timeout = 20000) {
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'manga-prototype-bot/1.0 (+https://example)' },
    timeout
  });
  return res.data;
}

/* -------------------------
   HEAD checker for page existence
   returns true if resource exists (status 200)
   allow 200..299 as success
   ------------------------- */
async function existsUrl(url, timeout = 8000) {
  try {
    const res = await axios({
      method: 'head',
      url,
      timeout,
      maxRedirects: 3,
      validateStatus: () => true
    });
    return res.status >= 200 && res.status < 300;
  } catch (e) {
    // some servers reject HEAD; try lightweight GET with Range header
    try {
      const res2 = await axios({
        method: 'get',
        url,
        headers: { Range: 'bytes=0-32' },
        timeout,
        maxRedirects: 3,
        validateStatus: () => true
      });
      return res2.status >= 200 && res2.status < 300;
    } catch (e2) {
      return false;
    }
  }
}

/* -------------------------
   Extractors (site-specific selectors you provided)
   All extractors are live (no server cache).
   ------------------------- */

/** extractHomePage(page): list of {slug,title,cover,link} */
async function extractHomePage(page = 1) {
  const url = page == 1 ? `${SITE_BASE}/page/1` : `${SITE_BASE}/page/${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = [];

  $('.manhwa-card').each((i, el) => {
    const a = $(el).find('a').first();
    const link = a.attr('href') ? new URL(a.attr('href'), SITE_BASE).href : null;
    const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
    let cover = $(el).find('img').attr('src') || $(el).find('.cover img').attr('src') || null;
    if (cover) cover = cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href;
    let slug = null;
    if (link) {
      const parts = new URL(link).pathname.split('/').filter(Boolean);
      const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
      slug = (idx >= 0 && parts.length > idx + 1) ? parts[idx + 1] : parts[parts.length - 1];
    }
    if (link && title) items.push({ slug, title, cover, link });
  });

  // fallback: links containing /Manhwa/ if nothing found
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
        items.push({ slug, title, cover: cover ? (cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href) : null, link: absolute });
      }
    });
  }

  return items;
}

/** extractGenres(): returns array of {name, slug, link} */
async function extractGenres() {
  const url = `${SITE_BASE}/gener.php`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const genres = [];
  $('.genre-btn a, a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('gener.php?slug=')) {
      try {
        const u = new URL(href, SITE_BASE);
        const slug = u.searchParams.get('slug');
        const name = $(el).text().trim();
        if (slug) genres.push({ name, slug, link: u.href });
      } catch (e) {}
    }
  });
  // dedupe
  return Array.from(new Map(genres.map(g => [g.slug, g])).values());
}

/** extractMangaDetail(slug): live fetch of manga page -> metadata + chapters (no images) */
async function extractMangaDetail(slug) {
  const url = `${SITE_BASE}/Manhwa/${slug}/`;
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

  // internal id (the B in readerpage.php?Chapter=A,B)
  let internalId = null;
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const m = href.match(/Chapter=[^,]+,([^&'"]+)/);
      if (m && m[1]) internalId = m[1];
    }
  });

  // chapters
  const chapters = [];
  $('.chapter-item a, .chapter-list a, .chapters a, a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const text = $(el).text().trim();
      const match = href.match(/Chapter=(\d+),([^&'"]+)/);
      let chapterNum = null;
      if (match) chapterNum = parseInt(match[1], 10);
      const absolute = new URL(href, SITE_BASE).href;
      chapters.push({ chapterNum, title: text || (chapterNum ? `Chapter ${chapterNum}` : `#${i+1}`), link: absolute });
    }
  });

  // dedupe and sort desc
  const uniq = {};
  chapters.forEach(c => { if (c.link) uniq[c.link] = c; });
  const list = Object.values(uniq).sort((a, b) => (b.chapterNum || 0) - (a.chapterNum || 0));

  // cover try
  let cover = $('.cover img, .card-img-top, img').first().attr('src') || null;
  if (cover) cover = cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href;

  return { slug, title, description, genres, internalId, cover, chapters, url };
}

/* -------------------------
   Reader extraction + accurate page count discovery
   ------------------------- */

/** extractReaderPages(readerUrl): attempts to extract explicit image URLs from reader page (static) */
async function extractReaderPages(readerUrl) {
  const html = await fetchHtml(readerUrl);
  const $ = cheerio.load(html);
  const imgs = [];

  $('img.manhwa-image').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
  });

  if (!imgs.length) {
    $('.mhreader, .mhreader-overlay, .reader, .reader-content').find('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
    });
  }

  if (!imgs.length) {
    $('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && (src.includes('cdn.') || src.includes('/users/') || src.endsWith('.webp') || src.endsWith('.jpg') || src.endsWith('.png'))) {
        imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
      }
    });
  }

  // sniff scripts for arrays or cdn urls
  if (!imgs.length) {
    const scripts = $('script').map((i, s) => $(s).html()).get().join('\n');
    const arrMatch = scripts.match(/\[\"(https?:\/\/[^"]+?\.(?:jpg|png|webp))\"(?:,\s*\"https?:\/\/[^"]+?\.(?:jpg|png|webp)\")+\]/);
    if (arrMatch) {
      try {
        const jsonArr = JSON.parse(arrMatch[0].replace(/\s/g, ''));
        if (Array.isArray(jsonArr)) imgs.push(...jsonArr);
      } catch (e) {}
    }
    const urlMatches = [...(scripts.matchAll(/https?:\/\/[^'"\s]+(?:webp|jpg|png)/g))].map(m => m[0]);
    if (urlMatches.length) imgs.push(...urlMatches);
  }

  return Array.from(new Set(imgs.map(u => u && (u.startsWith('http') ? u : new URL(u, SITE_BASE).href)).filter(Boolean)));
}

/**
 * buildFallbackPageUrl: construct single page URL from observed pattern
 * pattern assumed: https://cdn.megaman-server.ir/users/{uid}/{MANGA_NAME}/{CHAPTER}/HD/{PAGE}.webp
 * if UID unknown, user internalId might map to UID; function takes uid param.
 */
function buildFallbackPageUrl({ uid = '564', mangaName = '', chapter = '', page = 1 }) {
  const safe = encodeURIComponent(String(mangaName || '').replace(/\s+/g, '_'));
  return `https://${CDN_SAMPLE_HOST}/users/${uid}/${safe}/${chapter}/HD/${page}.webp`;
}

/**
 * discoverPageCountByHead: using exponential + binary search to find last existing page
 * returns exact page count (<= MAX_PAGE_CHECK) or null on failure
 */
async function discoverPageCountByHead({ uid, mangaName, chapter }) {
  const maxCap = MAX_PAGE_CHECK;
  // quick check first page
  const url1 = buildFallbackPageUrl({ uid, mangaName, chapter, page: 1 });
  if (!await existsUrl(url1)) return null;

  // exponential growth to find upper bound
  let low = 1, high = 1;
  while (high < maxCap) {
    const u = buildFallbackPageUrl({ uid, mangaName, chapter, page: high });
    const ok = await existsUrl(u);
    if (!ok) break;
    low = high;
    high = high * 2;
    if (high > maxCap) { high = maxCap; break; }
  }

  // if high still exists, maybe high==maxCap and exists => return maxCap
  const highUrl = buildFallbackPageUrl({ uid, mangaName, chapter, page: high });
  if (await existsUrl(highUrl)) return high; // hit cap

  // binary search between low (exists) and high (not exists)
  let left = low, right = high; // left exists, right does not
  while (left + 1 < right) {
    const mid = Math.floor((left + right) / 2);
    const midUrl = buildFallbackPageUrl({ uid, mangaName, chapter, page: mid });
    if (await existsUrl(midUrl)) left = mid;
    else right = mid;
  }
  return left;
}

/* -------------------------
   API endpoints (live)
   ------------------------- */

/** GET /api/home?page=N */
app.get('/api/home', async (req, res) => {
  try {
    const page = parseInt(req.query.page || '1', 10) || 1;
    const items = await extractHomePage(page);
    return res.json({ ok: true, page, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/genres */
app.get('/api/genres', async (req, res) => {
  try {
    const list = await extractGenres();
    return res.json({ ok: true, genres: list });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/genre/:slug?page=N */
app.get('/api/genre/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const page = parseInt(req.query.page || '1', 10) || 1;
    // try URL pattern: gener.php?slug={slug}&page={page} or gener.php?slug={slug} (some sites use query param page)
    const url = `${SITE_BASE}/gener.php?slug=${encodeURIComponent(slug)}${page > 1 ? '&page=' + page : ''}`;
    const html = await fetchHtml(url);
    const $ = cheerio.load(html);
    const items = [];
    $('.manhwa-card').each((i, el) => {
      const a = $(el).find('a').first();
      const link = a.attr('href') ? new URL(a.attr('href'), SITE_BASE).href : null;
      const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
      let cover = $(el).find('img').attr('src') || null;
      if (cover) cover = cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href;
      let slugInfer = null;
      if (link) {
        const parts = new URL(link).pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
        slugInfer = (idx >= 0 && parts.length > idx + 1) ? parts[idx + 1] : parts[parts.length - 1];
      }
      if (link && title) items.push({ slug: slugInfer, title, cover, link });
    });
    return res.json({ ok: true, genre: slug, page, items });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/** GET /api/manga/:slug  -> metadata + chapters (no images) */
app.get('/api/manga/:slug', async (req, res) => {
  try {
    const slug = req.params.slug;
    const detail = await extractMangaDetail(slug);
    return res.json({ ok: true, manga: detail });
  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/**
 * GET /api/reader/:slug/:chapter
 * returns pages[] and exact pageCount if possible, plus method info
 */
app.get('/api/reader/:slug/:chapter', async (req, res) => {
  try {
    const slug = req.params.slug;
    const chapter = req.params.chapter;

    // 1) get manga detail live to obtain chapters/internalId if needed
    const manga = await extractMangaDetail(slug);
    // try to find reader link for this chapter
    let chapterLink = null;
    if (manga.chapters && manga.chapters.length) {
      const found = manga.chapters.find(c => String(c.chapterNum) === String(chapter) || (c.title && c.title.includes(String(chapter))));
      if (found) chapterLink = found.link;
    }

    // 2) try explicit extraction from reader link
    if (chapterLink) {
      const pages = await extractReaderPages(chapterLink);
      if (pages && pages.length) {
        return res.json({ ok: true, method: 'explicit', pages, pageCount: pages.length });
      }
    }

    // 3) fallback: try to use internalId -> map to uid (we assume internalId correlates with uid)
    const uid = manga.internalId || null;
    const mangaName = manga.title || slug;
    if (uid) {
      // discover page count precisely using HEAD checks
      const pageCount = await discoverPageCountByHead({ uid, mangaName, chapter }).catch(()=>null);
      if (pageCount && pageCount > 0) {
        // build exact pages list
        const pages = [];
        for (let i = 1; i <= pageCount; i++) {
          pages.push(buildFallbackPageUrl({ uid, mangaName, chapter, page: i }));
        }
        return res.json({ ok: true, method: 'fallback-discovered', pages, pageCount });
      } else {
        // if discovery failed, still return a small guessed set as fallback with note
        const guessed = [];
        const guessCount = 25;
        for (let i = 1; i <= guessCount; i++) guessed.push(buildFallbackPageUrl({ uid, mangaName, chapter, page: i }));
        return res.json({ ok: true, method: 'fallback-guess', pages: guessed, note: 'exact pageCount could not be discovered; returned guessed first pages; consider enabling Playwright extractor if site builds reader via heavy JS.' });
      }
    }

    // 4) last resort: cannot produce pages
    return res.status(422).json({ ok: false, error: 'Could not extract pages. Ensure the manga slug is correct and the site does not rely on heavy JS to render reader. If so, use a Playwright-based extractor.' });

  } catch (e) {
    return res.status(500).json({ ok: false, error: e.message });
  }
});

/* basic health */
app.get('/api/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

/* a tiny front page for manual quick test */
app.get('/', (req, res) => {
  res.type('html').send(`<html><body style="font-family:Arial">
    <h3>Manga API (live extraction, no server cache)</h3>
    <p>/api/home?page=1 • /api/genres • /api/genre/:slug?page=N • /api/manga/:slug • /api/reader/:slug/:chapter</p>
    </body></html>`);
});

/* -------------------------
   Start
   ------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running http://localhost:${PORT} — live extraction mode (no server cache).`));
