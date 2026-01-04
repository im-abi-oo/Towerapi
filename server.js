// app.js  -- single-file prototype for manhwa API (tailored selectors)
// Dependencies: express, axios, cheerio, node-cron, murmurhash3js
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
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, JSON.stringify({ mangas: {}, lastHomeHash: '' }, null, 2), 'utf8');

function readDB() { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
function writeDB(db) { fs.writeFileSync(DATA_FILE, JSON.stringify(db, null, 2), 'utf8'); }

const app = express();
app.use(express.json());

/* -------------------------
   Helper: fetch HTML with sane headers
   ------------------------- */
async function fetchHtml(url) {
  const res = await axios.get(url, { headers: { 'User-Agent': 'manga-prototype-bot/1.0 (+https://example)' }, timeout: 20000 });
  return res.data;
}

/* -------------------------
   Extractors (using site-specific selectors you supplied)
   ------------------------- */

/** Home: find items via .manhwa-card a */
async function extractHome(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);
  const items = [];
  // each manhwa-card likely contains a link
  $('.manhwa-card').each((i, el) => {
    const a = $(el).find('a').first();
    const link = a.attr('href') || null;
    const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
    if (link && title) {
      const absolute = new URL(link, SITE_BASE).href;
      // slug guess: last non-empty path segment after /Manhwa/
      let slug = null;
      try {
        const p = new URL(absolute).pathname.split('/').filter(Boolean);
        // try to find segment after 'Manhwa'
        const idx = p.findIndex(s => s.toLowerCase() === 'manhwa');
        if (idx >= 0 && p.length > idx+1) slug = p[idx+1];
        else slug = p[p.length-1];
      } catch(e){}
      items.push({ title, link: absolute, slug });
    }
  });

  // fallback: find links like /Manhwa/{slug}/ if nothing found
  if (items.length === 0) {
    $('a[href*="/Manhwa/"]').each((i, el) => {
      const a = $(el);
      const href = a.attr('href');
      const title = a.attr('title') || a.text().trim();
      if (href && title) {
        const absolute = new URL(href, SITE_BASE).href;
        const p = new URL(absolute).pathname.split('/').filter(Boolean);
        const idx = p.findIndex(s => s.toLowerCase() === 'manhwa');
        const slug = (idx>=0 && p.length>idx+1) ? p[idx+1] : p[p.length-1];
        items.push({ title, link: absolute, slug });
      }
    });
  }

  return items;
}

/** Genres: .genre-btn a -> gener.php?slug=... */
async function extractGenres(url) {
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

/** Manga detail: title, genres, internalId from reader links, chapters from .chapter-item a */
async function extractMangaDetail(url) {
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('.display-5').first().text().trim() || $('.display-6').first().text().trim() || $('h1').first().text().trim() || $('title').text().trim();
  const genres = [];
  $('.genre-tag, .genre-badge, a[href*="gener.php"]').each((i, el) => {
    const t = $(el).text().trim();
    if (t) genres.push(t);
  });

  // find internal id (the B in readerpage.php?Chapter=A,B)
  let internalId = null;
  $('a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const m = href.match(/Chapter=[^,]+,([^&'"]+)/);
      if (m && m[1]) internalId = m[1];
    }
  });

  // chapters from .chapter-item
  const chapters = [];
  $('.chapter-item a, .chapter-list a, .chapters a, a').each((i, el) => {
    const href = $(el).attr('href') || '';
    if (href.includes('readerpage.php') && href.includes('Chapter=')) {
      const text = $(el).text().trim();
      const match = href.match(/Chapter=(\d+),([^&'"]+)/);
      let chapterNum = null;
      if (match) chapterNum = parseInt(match[1], 10);
      const absolute = new URL(href, SITE_BASE).href;
      chapters.push({ title: text || `Chapter ${chapterNum||i+1}`, link: absolute, chapter: chapterNum });
    }
  });

  // dedupe and sort by chapter number desc
  const uniq = {};
  chapters.forEach(c => { if (c.link) uniq[c.link] = c; });
  const list = Object.values(uniq).sort((a,b)=> (b.chapter||0)-(a.chapter||0));

  return { title, genres, internalId, chapters: list, url };
}

/* -------------------------
   Reader extraction: try to fetch the reader page and extract image URLs
   ------------------------- */
async function extractReaderImagesFromReaderUrl(readerUrl) {
  const html = await fetchHtml(readerUrl);
  const $ = cheerio.load(html);

  // Strategy:
  // 1) collect <img class="manhwa-image"> or images inside .mhreader container
  // 2) fall back to any <img> with src containing 'cdn.' or '.webp' or '/users/'
  const imgs = [];
  $('img.manhwa-image').each((i, el) => {
    const src = $(el).attr('src');
    if (src) imgs.push(new URL(src, SITE_BASE).href);
  });

  if (imgs.length === 0) {
    $('.mhreader, .mhreader-overlay, .reader, .reader-area, .reader-content').find('img').each((i,el)=>{
      const src = $(el).attr('src');
      if (src) imgs.push(new URL(src, SITE_BASE).href);
    });
  }

  if (imgs.length === 0) {
    $('img').each((i, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      if (src && (src.includes('cdn.') || src.includes('/users/') || src.endsWith('.webp') || src.endsWith('.jpg') || src.endsWith('.png'))) {
        imgs.push(new URL(src, SITE_BASE).href);
      }
    });
  }

  // some sites embed JSON or JS array of images; try to sniff
  if (imgs.length === 0) {
    const scripts = $('script').map((i, s) => $(s).html()).get().join('\n');
    // try to find arrays like ["...jpg","...jpg"]
    const arrMatch = scripts.match(/\[\"(https?:\/\/[^"]+?\.(?:jpg|png|webp))\"(?:,\s*\"https?:\/\/[^"]+?\.(?:jpg|png|webp)\")+\]/);
    if (arrMatch) {
      try {
        const jsonArr = JSON.parse(arrMatch[0].replace(/\s/g,''));
        if (Array.isArray(jsonArr)) imgs.push(...jsonArr);
      } catch(e){}
    }
    // try to find occurrences of cdn path
    const urlMatches = [...(scripts.matchAll(/https?:\/\/[^'"\s]+(?:webp|jpg|png)/g))].map(m => m[0]);
    if (urlMatches.length) imgs.push(...urlMatches);
  }

  // normalize and unique
  const uniq = Array.from(new Set(imgs.map(u => u && (u.startsWith('http') ? u : new URL(u, SITE_BASE).href)).filter(Boolean)));
  return uniq;
}

/* -------------------------
   CDN rule fallback builder (based on sample)
   pattern: https://cdn.megaman-server.ir/users/{uid}/{MANGA_NAME}/{CHAPTER}/HD/{PAGE}.webp
   We will only use as fallback if we cannot get explicit image list.
   ------------------------- */
function buildImageUrl({ uid, mangaName, chapter, page, quality = 'HD' }) {
  const safeName = encodeURIComponent(String(mangaName || '').replace(/\s+/g, '_'));
  return `https://cdn.megaman-server.ir/users/${uid}/${safeName}/${chapter}/${quality}/${page}.webp`;
}
function generatePageUrls({ uid, mangaName, chapter, pageCount = 30 }) {
  const urls = [];
  for (let i = 1; i <= pageCount; i++) urls.push(buildImageUrl({ uid, mangaName, chapter, page: i }));
  return urls;
}

/* -------------------------
   API Endpoints
   ------------------------- */
app.get('/', (req, res) => {
  res.type('html').send(`
  <!doctype html>
  <html>
  <head><meta charset="utf-8"><title>Manga Prototype</title>
  <style>body{font-family:Arial;max-width:900px;margin:20px auto;padding:10px} .m{border-bottom:1px solid #eee;padding:8px 0}</style>
  </head><body>
  <h1>Manga Prototype</h1>
  <div><button id="home">Load Home</button> <button id="genres">Load Genres</button></div>
  <div id="out"></div>
  <script>
    async function api(path){ const r=await fetch(path); return r.json(); }
    document.getElementById('home').onclick = async ()=>{
      const d = await api('/api/home');
      const out = document.getElementById('out'); out.innerHTML='';
      if(!d.ok){ out.textContent='error'; return; }
      d.items.forEach(it=>{
        const div=document.createElement('div'); div.className='m';
        div.innerHTML = '<strong>' + (it.title||'no-title') + '</strong><br><a href="'+it.link+'" target="_blank">'+it.link+'</a><br>'
          + '<button onclick="loadManga(\\''+it.slug+'\\')">Load detail</button>';
        out.appendChild(div);
      });
    };
    document.getElementById('genres').onclick = async ()=>{
      const d = await api('/api/genres'); document.getElementById('out').innerText = JSON.stringify(d, null, 2);
    };
    async function loadManga(slug){
      const d = await api('/api/manga/' + slug);
      const out = document.getElementById('out');
      out.innerHTML = '<h2>' + (d.manga.title||slug) + '</h2><pre>' + JSON.stringify(d.manga, null, 2) + '</pre>'
        + '<div><button onclick="loadReader(\\''+slug+'\\',141)">Sample reader (chapter 141)</button></div>';
    }
    async function loadReader(slug, chapter){
      const d = await api('/api/reader/' + slug + '/' + chapter);
      const out = document.getElementById('out');
      out.innerHTML += '<h3>Reader rule</h3><pre>' + JSON.stringify(d.rule, null, 2) + '</pre>';
      if(d.pages && d.pages.length){
        const imgs = d.pages.slice(0,10).map(u=>'<img src="'+u+'" style="max-width:150px;margin-right:6px">').join('');
        out.innerHTML += '<div>' + imgs + '</div>';
      } else out.innerHTML += '<div>No pages found</div>';
    }
  </script>
  </body></html>
  `);
});

app.get('/api/home', async (req,res)=>{
  try{
    const page = req.query.page || 1;
    const url = page == 1 ? `${SITE_BASE}/` : `${SITE_BASE}/page/${page}`;
    const items = await extractWithTimeout(() => extractHome(url), 20000);
    res.json({ ok: true, page, items });
  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/genres', async (req,res)=>{
  try{
    const list = await extractWithTimeout(() => extractGenres(`${SITE_BASE}/gener.php`), 20000);
    res.json({ ok:true, genres: list });
  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/manga/:slug', async (req,res)=>{
  try{
    const slug = req.params.slug;
    const url = `${SITE_BASE}/Manhwa/${slug}/`;
    const detail = await extractWithTimeout(() => extractMangaDetail(url), 20000);
    const db = readDB();
    db.mangas[slug] = { ...db.mangas[slug], ...detail };
    writeDB(db);
    res.json({ ok:true, manga: detail });
  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

/**
 * Reader: prefer explicit image list by fetching reader page.
 * If no explicit images found, try to use internalId (uid) + pattern as fallback.
 * If neither present, advise to fetch /api/manga/:slug first.
 */
app.get('/api/reader/:slug/:chapter', async (req,res)=>{
  try{
    const { slug, chapter } = req.params;
    const db = readDB();
    const manga = db.mangas[slug];
    if(!manga) return res.status(404).json({ ok:false, error:'manga not in db; call /api/manga/:slug first' });

    // try to find a reader link for this chapter in stored chapters
    let readerLink = null;
    if (manga.chapters && manga.chapters.length) {
      const found = manga.chapters.find(c => String(c.chapter) === String(chapter) || (c.title && c.title.includes(String(chapter))));
      if (found) readerLink = found.link;
    }

    // 1) if we have a readerLink -> fetch and extract images
    if (readerLink) {
      const images = await extractWithTimeout(() => extractReaderImagesFromReaderUrl(readerLink), 20000);
      if (images && images.length) {
        return res.json({ ok:true, method:'explicit', rule:{ readerLink }, pages: images });
      }
    }

    // 2) try to use internalId (uid) from manga detail
    const uid = manga.internalId || null;
    const mangaName = manga.title || slug;
    if (uid) {
      // try to guess pageCount by fetching readerLink if exists or fallback to 30
      let pageCount = 30;
      // if we had readerLink but no images, maybe lazy-load requires JS. We still try a small count.
      const pages = generatePageUrls({ uid, mangaName, chapter, pageCount });
      return res.json({ ok:true, method:'pattern-fallback', rule:{ uid, mangaName, chapter, pageCount }, pages });
    }

    // 3) last resort: attempt to fetch known reader endpoint constructed from pattern where internalId might be unknown
    // Inform caller that we couldn't find robust pages
    res.status(422).json({ ok:false, error:'Could not extract pages. Ensure /api/manga/:slug was called and that chapters/internalId exist. If reader uses heavy JS, consider using Playwright-based extractor.' });
  }catch(e){ res.status(500).json({ ok:false, error: e.message }); }
});

app.get('/api/health', (req,res)=> res.json({ ok:true, ts: Date.now() }));

/* -------------------------
   Scheduler: poll home for changes every 15 minutes
   ------------------------- */
cron.schedule('*/15 * * * *', async ()=> {
  console.log('[cron] polling home for changes...');
  try {
    const items = await extractWithTimeout(() => extractHome(`${SITE_BASE}/`), 20000);
    const hash = murmur.x86.hash128(JSON.stringify(items.map(i=>i.link)));
    const db = readDB();
    if (db.lastHomeHash !== hash) {
      console.log('[cron] home changed — updating DB snapshot');
      db.lastHomeHash = hash;
      items.forEach(it => {
        const slug = it.slug || (it.link && it.link.split('/').filter(Boolean).pop());
        if (slug) db.mangas[slug] = { ...db.mangas[slug], title: it.title, listLink: it.link };
      });
      writeDB(db);
    } else console.log('[cron] no change');
  } catch(e){
    console.error('[cron] error:', e.message);
  }
});

/* -------------------------
   Helper: run extractor with timeout
   ------------------------- */
function extractWithTimeout(fn, ms = 15000) {
  return new Promise((resolve, reject) => {
    let done = false;
    fn().then(r => { if(!done){ done=true; resolve(r); } }).catch(e=>{ if(!done){ done=true; reject(e); } });
    setTimeout(()=>{ if(!done){ done=true; reject(new Error('extractor timeout')); } }, ms);
  });
}

/* -------------------------
   Start server
   ------------------------- */
const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server running: http://localhost:${PORT} — endpoints: /api/home /api/genres /api/manga/:slug /api/reader/:slug/:chapter`));
