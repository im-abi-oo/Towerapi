// app.js — single-file prototype with modular endpoints:
// /api/home?page=N
// /api/manga/:slug
// /api/reader/:slug/:chapter
//
// deps: express, axios, cheerio, node-cron, murmurhash3js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cron = require('node-cron');
const murmur = require('murmurhash3js');
const fs = require('fs');
const path = require('path');

const SITE_BASE = 'https://manhwa-tower.ir';
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'db.json');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({
  homeCache: {},   // { pageNumber: [ {slug,title,cover,link} ] }
  mangas: {},      // { slug: { title, description, genres, cover, chapters:[{chapterNum,title,link}] } }
  readers: {},     // { slug: { chapterNum: { pages: [...] , fetchedAt: ts } } }
  lastHomeHash: ''
}, null, 2), 'utf8');

function readDB(){ return JSON.parse(fs.readFileSync(DATA_FILE,'utf8')); }
function writeDB(db){ fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); }

const app = express();
app.use(express.json());

/* -------------------------
   Basic HTML fetcher
   ------------------------- */
async function fetchHtml(url){
  const res = await axios.get(url, {
    headers: { 'User-Agent': 'manga-prototype-bot/1.0 (+https://example)' },
    timeout: 20000
  });
  return res.data;
}

/* -------------------------
   Extractors (site-specific selectors)
   ------------------------- */

/** extractHome: returns list of {slug, title, cover, link} from page N */
async function extractHomePage(page = 1){
  const url = page == 1 ? `${SITE_BASE}/page/1` : `${SITE_BASE}/page/${page}`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = [];

  // primary: .manhwa-card -> a (title/link), maybe img
  $('.manhwa-card').each((i, el) => {
    const a = $(el).find('a').first();
    const link = a.attr('href') ? new URL(a.attr('href'), SITE_BASE).href : null;
    const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
    // cover image if present
    let cover = $(el).find('img').attr('src') || $(el).find('.cover img').attr('src') || null;
    if (cover) cover = cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href;
    // slug inference
    let slug = null;
    try {
      if (link) {
        const parts = new URL(link).pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
        slug = (idx>=0 && parts.length>idx+1) ? parts[idx+1] : parts[parts.length-1];
      }
    } catch(e){}
    if (link && title) items.push({ slug, title, cover, link });
  });

  // fallback: links containing /Manhwa/
  if (!items.length) {
    $('a[href*="/Manhwa/"]').each((i, el) => {
      const a = $(el);
      const href = a.attr('href');
      const title = a.attr('title') || a.text().trim();
      if (href && title) {
        const absolute = new URL(href, SITE_BASE).href;
        const parts = new URL(absolute).pathname.split('/').filter(Boolean);
        const idx = parts.findIndex(s => s.toLowerCase() === 'manhwa');
        const slug = (idx>=0 && parts.length>idx+1) ? parts[idx+1] : parts[parts.length-1];
        const cover = a.find('img').attr('src') || null;
        items.push({ slug, title, cover: cover ? (cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href) : null, link: absolute });
      }
    });
  }

  return items;
}

/** extractGenres: simple list from gener.php */
async function extractGenres(){
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
      } catch(e){}
    }
  });
  return genres;
}

/** extractMangaDetail: return metadata + chapters (no images) */
async function extractMangaDetail(slug){
  const url = `${SITE_BASE}/Manhwa/${slug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('.display-5').first().text().trim() ||
                $('.display-6').first().text().trim() ||
                $('h1').first().text().trim() ||
                $('title').text().trim();

  // description: find a summary container common names
  let description = $('.kholase, .lead, .description, .post-content').first().text().trim() || '';
  if (!description) {
    // try meta description
    description = $('meta[name="description"]').attr('content') || '';
  }

  const genres = [];
  $('.genre-tag, .genre-badge, a[href*="gener.php"]').each((i, el) => {
    const t = $(el).text().trim();
    if (t) genres.push(t);
  });

  // find internal id from reader links on page (the B in Chapter=A,B)
  let internalId = null;
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const m = href.match(/Chapter=[^,]+,([^&'"]+)/);
      if (m && m[1]) internalId = m[1];
    }
  });

  // chapters: .chapter-item a
  const chapters = [];
  $('.chapter-item a, .chapter-list a, .chapters a, a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const text = $(el).text().trim();
      const match = href.match(/Chapter=(\d+),([^&'"]+)/);
      let chapterNum = null;
      if (match) chapterNum = parseInt(match[1],10);
      const absolute = new URL(href, SITE_BASE).href;
      chapters.push({ chapterNum, title: text || (chapterNum ? `Chapter ${chapterNum}` : `#${i+1}`), link: absolute });
    }
  });

  // dedupe+sort desc by chapterNum
  const uniq = {};
  chapters.forEach(c => { if (c.link) uniq[c.link] = c; });
  const list = Object.values(uniq).sort((a,b)=> (b.chapterNum||0)-(a.chapterNum||0));

  // try to find a cover image
  let cover = $('.cover img, .card-img-top, img').first().attr('src') || null;
  if (cover) cover = cover.startsWith('http') ? cover : new URL(cover, SITE_BASE).href;

  return { slug, title, description, genres, internalId, cover, chapters: list, url };
}

/* -------------------------
   Reader: extract page image URLs
   ------------------------- */
async function extractReaderPages(readerUrl){
  const html = await fetchHtml(readerUrl);
  const $ = cheerio.load(html);

  const imgs = [];
  // 1) try .manhwa-image
  $('img.manhwa-image').each((i, el) => {
    const src = $(el).attr('src') || $(el).attr('data-src');
    if (src) imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
  });

  // 2) try reader container
  if (!imgs.length) {
    $('.mhreader, .mhreader-overlay, .reader, .reader-content').find('img').each((i,el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src) imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
    });
  }

  // 3) any img that looks like cdn or webp/jpg/png
  if (!imgs.length) {
    $('img').each((i,el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && (src.includes('cdn.') || src.includes('/users/') || src.endsWith('.webp') || src.endsWith('.jpg') || src.endsWith('.png'))) {
        imgs.push(src.startsWith('http') ? src : new URL(src, SITE_BASE).href);
      }
    });
  }

  // 4) sniff scripts for arrays or cdn urls
  if (!imgs.length) {
    const scripts = $('script').map((i,s) => $(s).html()).get().join('\n');
    // array pattern
    const arrMatch = scripts.match(/\[\"(https?:\/\/[^"]+?\.(?:jpg|png|webp))\"(?:,\s*\"https?:\/\/[^"]+?\.(?:jpg|png|webp)\")+\]/);
    if (arrMatch) {
      try {
        const jsonArr = JSON.parse(arrMatch[0].replace(/\s/g,''));
        if (Array.isArray(jsonArr)) imgs.push(...jsonArr);
      } catch(e){}
    }
    // any urls
    const urlMatches = [...(scripts.matchAll(/https?:\/\/[^'"\s]+(?:webp|jpg|png)/g))].map(m => m[0]);
    if (urlMatches.length) imgs.push(...urlMatches);
  }

  // normalize unique
  const uniq = Array.from(new Set(imgs.map(u => u && (u.startsWith('http') ? u : new URL(u, SITE_BASE).href)).filter(Boolean)));
  return uniq;
}

/* -------------------------
   CDN fallback (pattern)
   sample: https://cdn.megaman-server.ir/users/{uid}/{MANGA_NAME}/{CHAPTER}/HD/{PAGE}.webp
   use only when explicit pages not available
   ------------------------- */
function buildFallbackPageUrls({ uid, mangaName, chapter, pageCount = 30 }){
  const safe = encodeURIComponent(String(mangaName||'').replace(/\s+/g,'_'));
  const base = `https://cdn.megaman-server.ir/users/${uid || '564'}/${safe}/${chapter}/HD`;
  const arr = [];
  for (let i=1;i<=pageCount;i++) arr.push(`${base}/${i}.webp`);
  return arr;
}

/* -------------------------
   API endpoints
   ------------------------- */

/**
 * Home: paginated list
 * returns JSON array of { slug, title, cover, link }
 */
app.get('/api/home', async (req,res)=>{
  try{
    const page = parseInt(req.query.page||'1',10) || 1;
    const db = readDB();
    // if cached, return
    if (db.homeCache && db.homeCache[page]) return res.json({ ok:true, page, items: db.homeCache[page] });

    // else extract and cache
    const items = await extractWithTimeout(()=>extractHomePage(page), 20000);
    db.homeCache = db.homeCache || {};
    db.homeCache[page] = items;
    writeDB(db);
    res.json({ ok:true, page, items });
  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

/**
 * Manga detail: returns metadata + chapters (no images)
 */
app.get('/api/manga/:slug', async (req,res)=>{
  try{
    const slug = req.params.slug;
    const db = readDB();
    // if cached and has chapters, return
    if (db.mangas && db.mangas[slug] && db.mangas[slug].chapters && db.mangas[slug].chapters.length) {
      return res.json({ ok:true, manga: db.mangas[slug] });
    }
    // else extract and store
    const detail = await extractWithTimeout(()=>extractMangaDetail(slug), 20000);
    db.mangas = db.mangas || {};
    db.mangas[slug] = { ...(db.mangas[slug]||{}), ...detail, fetchedAt: Date.now() };
    writeDB(db);
    res.json({ ok:true, manga: db.mangas[slug] });
  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

/**
 * Reader: returns pages[] for given slug+chapter
 * Steps:
 * 1) try to find reader link from stored manga chapters and fetch explicit images
 * 2) if not found or images empty, but internalId exists -> construct fallback pattern
 * 3) else 422 with guidance
 */
app.get('/api/reader/:slug/:chapter', async (req,res)=>{
  try{
    const slug = req.params.slug;
    const chapter = req.params.chapter;
    const db = readDB();
    const manga = db.mangas && db.mangas[slug];

    if (!manga) return res.status(404).json({ ok:false, error:'manga not cached; call /api/manga/:slug first' });

    // try to find chapter link
    let chapterLink = null;
    if (manga.chapters && manga.chapters.length) {
      const found = manga.chapters.find(c => String(c.chapterNum) === String(chapter) || (c.title && c.title.includes(String(chapter))));
      if (found) chapterLink = found.link;
    }

    // if we have cached reader pages, return
    db.readers = db.readers || {};
    db.readers[slug] = db.readers[slug] || {};
    if (db.readers[slug][chapter] && db.readers[slug][chapter].pages && db.readers[slug][chapter].pages.length) {
      return res.json({ ok:true, method:'cache', pages: db.readers[slug][chapter].pages });
    }

    // 1) if chapterLink present, try to parse explicit pages
    if (chapterLink) {
      const pages = await extractWithTimeout(()=>extractReaderPages(chapterLink), 20000).catch(()=>[]);
      if (pages && pages.length) {
        db.readers[slug][chapter] = { pages, fetchedAt: Date.now(), method:'explicit' };
        writeDB(db);
        return res.json({ ok:true, method:'explicit', pages });
      }
    }

    // 2) try fallback using internalId stored in manga.internalId
    const uid = manga.internalId || manga.internalId || null;
    if (uid) {
      // try small pageCount fallback to avoid huge guesses; app can request more pages if exists
      const pageCountGuess = 25;
      const pages = buildFallbackPageUrls({ uid, mangaName: manga.title || slug, chapter, pageCount: pageCountGuess });
      db.readers[slug][chapter] = { pages, fetchedAt: Date.now(), method:'fallback', note:'guessed pageCount' };
      writeDB(db);
      return res.json({ ok:true, method:'fallback', pages });
    }

    // 3) last resort: cannot extract
    return res.status(422).json({ ok:false, error:'Could not obtain pages. Ensure /api/manga/:slug was called and that chapters/internalId exist. If reader requires JS to build pages, consider Playwright-based extractor.' });

  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

/* health */
app.get('/api/health', (req,res)=> res.json({ ok:true, ts: Date.now() }) );

/* simple front page for manual testing */
app.get('/', (req,res)=>{
  res.type('html').send(`
  <html><head><meta charset="utf-8"><title>Manga API</title></head><body style="font-family:Arial, sans-serif;max-width:900px;margin:20px auto">
  <h2>Manga Prototype API</h2>
  <p>Endpoints: <code>/api/home?page=N</code> • <code>/api/manga/:slug</code> • <code>/api/reader/:slug/:chapter</code></p>
  <div><button onclick="loadHome()">load home (page1)</button></div>
  <pre id="out"></pre>
  <script>
    async function api(p){ const r = await fetch(p); return r.json(); }
    async function loadHome(){
      const d = await api('/api/home?page=1');
      document.getElementById('out').innerText = JSON.stringify(d, null, 2);
    }
  </script>
  </body></html>
  `);
});

/* -------------------------
   Cron: poll /page/1 every 15 minutes to detect updates
   ------------------------- */
cron.schedule('*/15 * * * *', async ()=>{
  try{
    console.log('[cron] poll page/1');
    const items = await extractWithTimeout(()=>extractHomePage(1), 20000).catch(()=>[]);
    const db = readDB();
    const hash = murmur.x86.hash128(JSON.stringify(items.map(i=>i.link)));
    if (db.lastHomeHash !== hash) {
      console.log('[cron] home changed — update cache and db snapshot');
      db.lastHomeHash = hash;
      db.homeCache = db.homeCache || {};
      db.homeCache[1] = items;
      // upsert titles/slugs into mangas minimal record
      db.mangas = db.mangas || {};
      items.forEach(it => {
        if (it.slug) db.mangas[it.slug] = { ...(db.mangas[it.slug]||{}), slug: it.slug, title: it.title, cover: it.cover, listLink: it.link, updatedAt: Date.now() };
      });
      writeDB(db);
    } else {
      console.log('[cron] no change');
    }
  }catch(e){ console.error('[cron] error', e.message); }
});

/* timeout wrapper for extractors */
function extractWithTimeout(fn, ms=15000){
  return new Promise((resolve, reject)=>{
    let done = false;
    fn().then(r=>{ if(!done){ done=true; resolve(r); } }).catch(e=>{ if(!done){ done=true; reject(e); } });
    setTimeout(()=>{ if(!done){ done=true; reject(new Error('extractor timeout')); } }, ms);
  });
}

/* start */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server running http://localhost:${PORT} — endpoints: /api/home /api/manga/:slug /api/reader/:slug/:chapter`));
