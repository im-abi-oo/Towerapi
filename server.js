// server.js
const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const path = require('path');
const compression = require('compression');
const helmet = require('helmet');
const morgan = require('morgan');
const cors = require('cors');

const SITE_BASE = 'https://manhwa-tower.ir';
const CDN_SAMPLE_HOST = 'cdn.megaman-server.ir';
const MAX_PAGE_CHECK = 2000;

const app = express();
app.use(express.json({ limit: '200kb' }));
app.use(compression());
app.use(helmet());
app.use(morgan('tiny'));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '1d' }));

/* utilities */
function logErr(err, ctx='') { console.error('[ERROR]', ctx, err && (err.stack||err.message||err)); }
function sanitizeSlug(slug){ if(!slug || typeof slug!=='string') return null; const m = slug.match(/[A-Za-z0-9\-_]+/g); return m ? m.join('-') : null; }
function parsePage(q,fallback=1){ const p = parseInt(q||String(fallback),10); if(isNaN(p)||p<1) return fallback; return p; }
function normalizeChapterParam(ch){ if(!ch) return null; return String(ch).replace(/[_\s]+/g,'.').trim(); }

/* network helpers */
async function fetchHtml(url, timeout=20000){
  try{
    const r = await axios.get(url, { headers: {'User-Agent':'manga-proxy/1.0'}, timeout, maxRedirects:5, validateStatus: s=> s>=200 && s<400 });
    return r.data;
  }catch(e){
    const err = new Error(`fetchHtml failed for ${url}: ${e.message}`); err.original = e; throw err;
  }
}
async function existsUrl(url, timeout=8000){
  try{
    const r = await axios.head(url, { timeout, maxRedirects:3, validateStatus: ()=>true });
    return r.status >=200 && r.status < 300;
  }catch(e){
    try{
      const r2 = await axios.get(url, { headers:{ Range:'bytes=0-32','User-Agent':'manga-proxy/1.0' }, timeout, maxRedirects:3, validateStatus: ()=>true });
      return r2.status >=200 && r2.status < 300;
    }catch(_){ return false; }
  }
}

/* extractors (kept robust, with fixes) */
async function extractHomePage(page=1){
  const candidates = [`${SITE_BASE}/page/${page}`, `${SITE_BASE}/page/${page}/`, `${SITE_BASE}/?paged=${page}`, `${SITE_BASE}/?page=${page}`, `${SITE_BASE}/page/${page}?ajax=1`];
  let html=null;
  for(const u of candidates){
    try{
      html = await fetchHtml(u);
      if(html && (html.includes('manhwa-card') || html.match(/\/Manhwa\/[A-Za-z0-9\-_]+/i) || html.includes('gener.php'))) break;
    }catch(e){ logErr(e, `extractHomePage candidate ${u}`); }
  }
  if(!html) throw new Error('Could not fetch home page HTML for any pagination pattern.');
  const $ = cheerio.load(html);
  const map = new Map();

  // find cards
  $('[class*="manhwa-card"], .manhwa-card, article, .post, .card').each((i, el)=>{
    try{
      const a = $(el).find('a').first();
      const href = a.attr('href') || '';
      let link = href ? new URL(href, SITE_BASE).href : null;
      if(!link){
        // try anchors inside
        const inner = $(el).find('a[href]').first();
        const h2 = inner.attr('href')||'';
        if(h2) link = new URL(h2, SITE_BASE).href;
      }
      const img = $(el).find('img').first();
      let cover = img && (img.attr('data-src') || img.attr('data-lazy-src') || img.attr('src') || img.attr('data-original')) || null;
      if(cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;
      const title = a.attr('title') || (img && img.attr('alt')) || $(el).find('h2, h3').first().text().trim() || a.text().trim();
      if(link && title) map.set(link, { link, title: title.trim(), cover });
    }catch(e){}
  });

  // fallback: anchors with /Manhwa/
  $('a[href]').each((i, el)=>{
    try{
      const href = $(el).attr('href')||'';
      if(!href.match(/\/(Manhwa|manhwa|manga)\/[A-Za-z0-9\-_]+/i)) return;
      const link = new URL(href, SITE_BASE).href;
      if(map.has(link)) return;
      const img = $(el).find('img').first();
      let cover = img && (img.attr('data-src')||img.attr('src')) || null;
      if(cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;
      const title = $(el).attr('title') || (img && img.attr('alt')) || $(el).text().trim();
      if(link && title) map.set(link, { link, title: title.trim(), cover });
    }catch(e){}
  });

  return Array.from(map.values());
}

async function extractGenresPage(pageUrl=`${SITE_BASE}/gener.php`){
  const html = await fetchHtml(pageUrl);
  const $ = cheerio.load(html);
  const genres = [];
  $('a').each((i,el)=>{
    const href = $(el).attr('href')||'';
    const text = $(el).text().trim();
    if(!href||!text) return;
    if(href.includes('slug=') || /\/genre\//i.test(href) || /gener.php/i.test(href) ){
      try{
        const resolved = new URL(href, pageUrl);
        const slug = resolved.searchParams.get('slug') || resolved.pathname.split('/').filter(Boolean).pop();
        if(slug) genres.push({ name:text, slug, link: resolved.href });
      }catch(e){}
    }
  });
  // extra lists
  $('ul, .genre-list, .tags').find('a').each((i,el)=>{
    const href = $(el).attr('href')||''; const text = $(el).text().trim(); if(!href||!text) return;
    try{ const resolved = new URL(href, pageUrl); const slug = resolved.searchParams.get('slug') || resolved.pathname.split('/').filter(Boolean).pop(); if(slug) genres.push({name:text, slug, link:resolved.href}); }catch(e){}
  });
  const map = new Map(); for(const g of genres) if(g.slug && !map.has(g.slug)) map.set(g.slug, g);
  return Array.from(map.values());
}
async function extractGenres(totalPages=1){ const p = Math.max(1,Number(totalPages)||1); const urls = []; for(let i=1;i<=p;i++) urls.push(`${SITE_BASE}/gener.php${i>1? '?page='+i:''}`); const settled = await Promise.allSettled(urls.map(u=>extractGenresPage(u))); const merged=[]; for(const s of settled){ if(s.status==='fulfilled'&&Array.isArray(s.value)) merged.push(...s.value); else logErr(s.status==='rejected'?s.reason:'unknown','extractGenres'); } const map = new Map(); for(const g of merged) if(g.slug && !map.has(g.slug)) map.set(g.slug, g); return Array.from(map.values()); }

/* ------- extractMangaDetail: improved ------- */
async function extractMangaDetail(slug){
  const safeSlug = sanitizeSlug(slug) || slug;
  const url = `${SITE_BASE}/Manhwa/${safeSlug}/`;
  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const title = $('.display-5').first().text().trim() || $('.display-6').first().text().trim() || $('h1').first().text().trim() || $('title').text().trim();

  let description = $('.kholase, .lead, .description, .post-content').first().text().trim() || $('meta[name="description"]').attr('content') || '';

  // genres
  const genres = [];
  $('.genre-tag, .genre-badge, a[href*="gener.php"]').each((i,el)=>{ const t = $(el).text().trim(); if(t) genres.push(t); });

  // cover fallback: try known selectors then meta og:image
  let cover = $('.cover img, .card-img-top img, img.cover, img.thumb').first().attr('src') || $('.cover img, .card-img-top img, img.cover').first().attr('data-src') || null;
  if(!cover){
    cover = $('meta[property="og:image"]').attr('content') || $('link[rel="image_src"]').attr('href') || null;
  }
  if(cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;

  // internalId extraction from reader links (group 2)
  let internalId = null;
  // we'll collect chapters with both display number and internal id
  const chapters = [];

  $('a[href]').each((i,el)=>{
    const href = $(el).attr('href')||'';
    if(href.includes('readerpage.php') && href.includes('Chapter=')){
      const m = href.match(/Chapter=([0-9]+(?:\.[0-9]+)?),([^&'"]+)/);
      if(m){
        // m[1] = display number (e.g. 190), m[2] = internal id (e.g. 103 or some token)
        internalId = internalId || m[2];
      }
    }
  });

  // prefer explicit chapter list selectors
  $('.chapter-item a, .chapter-list a, .chapters a').each((i,el)=>{
    try{
      const href = $(el).attr('href')||'';
      const text = $(el).text().trim();
      const match = href.match(/Chapter=([0-9]+(?:\.[0-9]+)?),([^&'"]+)/);
      let chapterId = null; let chapterNum = null; let internal = null;
      if(match){ chapterNum = Number(match[1]); chapterId = `${match[1]},${match[2]}`; internal = match[2]; }
      else {
        const m2 = text.match(/([0-9]+(?:\.[0-9]+)?)/);
        if(m2){ chapterNum = Number(m2[1]); chapterId = String(m2[1]); }
      }
      const absolute = href ? new URL(href, SITE_BASE).href : null;
      const titleFallback = text || (chapterId ? `Chapter ${chapterId}` : `#${i+1}`);
      if(absolute) chapters.push({ chapterId: chapterId || String(i+1), chapterNum: isFinite(chapterNum)?chapterNum:null, internalId: internal || null, title: titleFallback, link: absolute });
    }catch(e){}
  });

  // fallback scanning: pick up any readerpage.php links
  if(!chapters.length){
    $('a[href]').each((i,el)=>{
      const href = $(el).attr('href')||'';
      if(href.includes('readerpage.php')){
        try{
          const text = $(el).text().trim() || `#${i+1}`;
          const match = href.match(/Chapter=([0-9]+(?:\.[0-9]+)?),([^&'"]+)/);
          let chapterId = match ? `${match[1]},${match[2]}` : String(i+1);
          let chapterNum = match ? Number(match[1]) : null;
          const absolute = new URL(href, SITE_BASE).href;
          const internal = match ? match[2] : null;
          chapters.push({ chapterId, chapterNum: isFinite(chapterNum)?chapterNum:null, internalId: internal, title: text, link: absolute });
        }catch(e){}
      }
    });
  }

  // dedupe & sort: ensure latest first by chapterNum if available
  const uniq = {};
  chapters.forEach(c => { if(c.link) uniq[c.link] = c; });
  const list = Object.values(uniq).sort((a,b)=>{
    const an = (typeof a.chapterNum==='number')? a.chapterNum : -Infinity;
    const bn = (typeof b.chapterNum==='number')? b.chapterNum : -Infinity;
    if(an !== bn) return bn - an;
    if(a.chapterId && b.chapterId) return (a.chapterId > b.chapterId) ? -1 : (a.chapterId < b.chapterId ? 1 : 0);
    return 0;
  });

  return { slug: safeSlug, title, description, genres, internalId, cover, chapters: list, url };
}

/* extractReaderPages (unchanged but robust) */
async function extractReaderPages(readerUrl){
  const html = await fetchHtml(readerUrl);
  const $ = cheerio.load(html);
  const imgs = [];
  // direct selectors
  $('img.manhwa-image, img.reader-img, .reader img, .mhreader img').each((i,el)=>{
    const src = $(el).attr('src') || $(el).attr('data-src') || $(el).attr('data-lazy-src') || $(el).attr('data-srcset') || $(el).attr('srcset');
    if(!src) return;
    let chosen = src;
    if(chosen.includes(',')) chosen = chosen.split(',')[0].trim().split(' ')[0];
    if(chosen && !chosen.startsWith('http')) chosen = new URL(chosen, readerUrl).href;
    imgs.push(chosen);
  });
  // noscript
  $('noscript').each((i,el)=>{
    const inner = $(el).html()||'';
    const $$ = cheerio.load(inner);
    $$('img').each((j,im)=>{
      const s = $$(im).attr('src') || $$(im).attr('data-src');
      if(s) imgs.push(s.startsWith('http')?s:new URL(s, readerUrl).href);
    });
  });
  // iframe
  const iframeSrc = $('iframe[src]').first().attr('src');
  if(iframeSrc){
    try{
      const abs = new URL(iframeSrc, readerUrl).href;
      const iframeHtml = await fetchHtml(abs);
      const $$ = cheerio.load(iframeHtml);
      $$('img').each((i,el)=> {
        const s = $$(el).attr('src') || $$(el).attr('data-src');
        if(s) imgs.push(s.startsWith('http')?s:new URL(s, abs).href);
      });
    }catch(e){ logErr(e,'iframe fetch in extractReaderPages'); }
  }
  // scripts arrays and matches
  const scripts = $('script').map((i,s)=>$(s).html()).get().join('\n') || '';
  const arrMatches = [...scripts.matchAll(/\[\s*["'](https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp))["'](?:\s*,\s*["']https?:\/\/[^"']+\.(?:jpg|jpeg|png|webp)["'])+\s*\]/g)];
  for(const m of arrMatches){
    try{ const parsed = JSON.parse(m[0]); if(Array.isArray(parsed)) parsed.forEach(u=>imgs.push(u)); }catch(e){}
  }
  const urlMatches = [...scripts.matchAll(/https?:\/\/[^'"\s]+?(?:webp|jpg|jpeg|png)/g)].map(m=>m[0]);
  urlMatches.forEach(u=>imgs.push(u));
  if(!imgs.length){
    $('img').each((i,el)=>{
      const src = $(el).attr('src') || $(el).attr('data-src');
      if(src) imgs.push(src.startsWith('http')?src:new URL(src, readerUrl).href);
    });
  }
  const cleaned = Array.from(new Set(imgs.map(u => { if(!u) return null; const s = String(u).trim(); return (s.startsWith('http')?s: (new URL(s, SITE_BASE).href)); }).filter(Boolean)));
  return cleaned;
}

/* fallback CDN + page discovery (unchanged) */
function buildFallbackPageUrl({ uid='564', mangaName='', chapter='', page=1 }){
  const safe = encodeURIComponent(String(mangaName||'').replace(/\s+/g,'_'));
  return `https://${CDN_SAMPLE_HOST}/users/${uid}/${safe}/${chapter}/HD/${page}.webp`;
}
async function discoverPageCountByHead({ uid, mangaName, chapter }){
  const maxCap = MAX_PAGE_CHECK;
  const url1 = buildFallbackPageUrl({ uid, mangaName, chapter, page:1 });
  if(!await existsUrl(url1)) return null;
  let low=1, high=1;
  while(high < maxCap){
    const u = buildFallbackPageUrl({ uid, mangaName, chapter, page: high });
    const ok = await existsUrl(u);
    if(!ok) break;
    low = high; high = high * 2;
    if(high > maxCap){ high = maxCap; break; }
  }
  if(await existsUrl(buildFallbackPageUrl({ uid, mangaName, chapter, page: high }))) return high;
  let left = low, right = high;
  while(left + 1 < right){
    const mid = Math.floor((left + right)/2);
    if(await existsUrl(buildFallbackPageUrl({ uid, mangaName, chapter, page: mid }))) left = mid;
    else right = mid;
  }
  return left;
}

/* Popular & recommendations (unchanged) */
const POPULAR_TTL_MS = 5*60*1000; const MAX_POPULAR = 10; let _popularCache = { ts:0, items:[], count:0};
async function fetchPopularItems(count=MAX_POPULAR){
  const want = Math.max(1, Math.min(Number(count)||MAX_POPULAR, MAX_POPULAR));
  const now = Date.now();
  if(_popularCache.ts && (now - _popularCache.ts) < POPULAR_TTL_MS && _popularCache.count===want) return _popularCache.items.slice(0,want);
  try{ const pageItems = await extractHomePage(1); const seen = new Set(); const out=[]; for(const it of pageItems){ const key=(it.link||it.title||'').trim(); if(!key) continue; if(seen.has(key)) continue; seen.add(key); out.push(it); if(out.length>=want) break; } _popularCache={ts:now, items:out, count:want}; return out; }catch(e){ logErr(e,'fetchPopularItems'); return []; }
}
async function fetchHomePages(pages=3, maxItems=500){ const p=Math.max(1,Math.min(Number(pages)||1,20)); const map=new Map(); for(let i=1;i<=p;i++){ try{ const items = await extractHomePage(i); for(const it of items){ const key=(it.link||it.title||'').trim(); if(!key) continue; if(!map.has(key)) map.set(key, it); if(map.size>=maxItems) break; } }catch(e){ logErr(e, `fetchHomePages page ${i}`); } if(map.size>=maxItems) break;} return Array.from(map.values()); }
function seededRng(seed){ let x = seed >>> 0; return function(){ x ^= x << 13; x = x >>> 0; x ^= x >>> 17; x = x >>> 0; x ^= x << 5; x = x >>> 0; return (x >>> 0) / 4294967295; }; }
function seededShuffle(array, seed){ const a = array.slice(); const rnd = seededRng(seed); for(let i=a.length-1;i>0;i--){ const j = Math.floor(rnd()*(i+1)); [a[i],a[j]]=[a[j],a[i]]; } return a; }

/* ----------------- API endpoints ----------------- */

/* /api/home */
app.get('/api/home', async (req,res)=>{
  try{
    const page = parsePage(req.query.page || '1', 1);
    const ex = req.query.exclude_popular;
    const excludePopular = ex === '1' || String(ex).toLowerCase() === 'true' || ex === 'yes';
    let items = await extractHomePage(page);
    // dedupe by link/title
    const seen = new Set();
    items = items.filter(it => {
      const key = (it.link||it.title||'').trim();
      if(!key || seen.has(key)) return false;
      seen.add(key); return true;
    });
    if(req.query.page) items = items.slice(10);
    if(excludePopular){
      const count = Math.max(1, Math.min(Number(req.query.popular_count) || MAX_POPULAR, MAX_POPULAR));
      const popular = await fetchPopularItems(count);
      const popSet = new Set(popular.map(p => (p.link||p.title||'').trim()));
      items = items.filter(it => !popSet.has((it.link||it.title||'').trim()));
    }
    // ensure every item has cover fallback
    items = items.map(it => {
      if(!it.cover) it.cover = it.link ? `${SITE_BASE}/wp-content/uploads/placeholder-cover.jpg` : '/placeholder.png';
      return it;
    });
    return res.json({ ok:true, page, items, excludePopular: !!excludePopular });
  }catch(e){ logErr(e,'/api/home'); return res.status(500).json({ ok:false, error: e.message||'internal' }); }
});

/* genres */
app.get('/api/genres', async (req,res)=>{ try{ const pages = Math.max(1, Number(req.query.pages)||1); const list = await extractGenres(pages); return res.json({ ok:true, pages, genres: list }); }catch(e){ logErr(e,'/api/genres'); return res.status(500).json({ ok:false, error:e.message }); } });

/* genre/:slug */
app.get('/api/genre/:slug', async (req,res)=>{
  try{
    const rawSlug = req.params.slug; const slug = sanitizeSlug(rawSlug) || rawSlug;
    const startPage = parsePage(req.query.page || '1',1);
    const pages = Math.max(1, Number(req.query.pages) || 1);
    const pageNumbers = Array.from({ length: pages }, (_, i) => startPage + i);
    const fetches = pageNumbers.map(pn => (async ()=>{
      const url = `${SITE_BASE}/gener.php?slug=${encodeURIComponent(slug)}${pn>1? '&page='+pn: ''}`;
      const html = await fetchHtml(url); const $ = cheerio.load(html); const items=[];
      $('.manhwa-card').each((i,el)=>{
        try{
          const a = $(el).find('a').first(); const href = a.attr('href')||''; const link = href ? new URL(href, SITE_BASE).href : null;
          let cover = $(el).find('img').attr('data-src') || $(el).find('img').attr('src') || null;
          if(cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href;
          let slugInfer = null;
          if(link){ const parts = new URL(link).pathname.split('/').filter(Boolean); const idx = parts.findIndex(s => s.toLowerCase()==='manhwa'); slugInfer = (idx>=0 && parts.length>idx+1) ? parts[idx+1] : parts[parts.length-1]; }
          const title = a.attr('title') || a.text().trim() || $(el).find('.card-title').text().trim();
          if(link && title) items.push({ slug: slugInfer, title, cover, link });
        }catch(e){}
      });
      $('a[href]').each((i,el)=>{
        try{
          const a = $(el); const href = a.attr('href')||''; if(!href.match(/\/(Manhwa|manhwa|manga)\/[A-Za-z0-9\-_]+/i)) return; const link = new URL(href, SITE_BASE).href; if(items.find(it=>it.link===link)) return; const img = a.find('img').first(); let cover = img && (img.attr('data-src')||img.attr('src'))||null; if(cover && !cover.startsWith('http')) cover = new URL(cover, SITE_BASE).href; const title = a.attr('title') || (img && img.attr('alt')) || a.text().trim(); if(link && title) items.push({ slug:null, title, cover, link });
        }catch(e){}
      });
      return items;
    })());
    const settled = await Promise.allSettled(fetches); const merged=[];
    for(const s of settled){ if(s.status==='fulfilled' && Array.isArray(s.value)) merged.push(...s.value); else logErr(s.status==='rejected' ? s.reason : 'unknown', '/api/genre/:slug fetch'); }
    const uniq = {}; merged.forEach(it=>{ if(it.link) uniq[it.link] = it; });
    const items = Object.values(uniq);
    return res.json({ ok:true, genre: slug, startPage, pagesFetched: pageNumbers.length, items });
  }catch(e){ logErr(e,'/api/genre/:slug'); return res.status(500).json({ ok:false, error: e.message }); }
});

/* manga detail */
app.get('/api/manga/:slug', async (req,res)=>{
  try{
    const rawSlug = req.params.slug; const slug = sanitizeSlug(rawSlug) || rawSlug;
    const detail = await extractMangaDetail(slug);
    // ensure cover fallback
    if(!detail.cover) detail.cover = '/placeholder.png';
    return res.json({ ok:true, manga: detail });
  }catch(e){ logErr(e,'/api/manga/:slug'); return res.status(500).json({ ok:false, error: e.message }); }
});
app.get('/api/manga', async (req,res)=>{ try{ const rawSlug = req.query.slug; if(!rawSlug) return res.status(400).json({ ok:false, error:'missing slug query' }); const slug = sanitizeSlug(rawSlug) || rawSlug; const detail = await extractMangaDetail(slug); if(!detail.cover) detail.cover = '/placeholder.png'; return res.json({ ok:true, manga:detail }); }catch(e){ logErr(e,'/api/manga(query)'); return res.status(500).json({ ok:false, error: e.message }); } });

/* reader endpoints (support slug/chapter where chapter may be "190" or "190,103") */
app.get('/api/reader/:slug/:chapter', async (req,res)=> handleReaderQuery({ slug: req.params.slug, chapter: req.params.chapter }, res) );
app.get('/api/reader', async (req,res)=> handleReaderQuery(req.query, res) );

async function handleReaderQuery(query, res){
  try{
    const rawSlug = query.slug; const rawChapter = query.chapter;
    if(!rawSlug || !rawChapter) return res.status(400).json({ ok:false, error:'slug and chapter required' });
    const slug = sanitizeSlug(rawSlug) || rawSlug;
    const chapterParam = normalizeChapterParam(rawChapter);

    const manga = await extractMangaDetail(slug);
    // try exact match: if client supplied full id like "190,103" match chapter.chapterId exactly
    let chapterLink = null; let matchedChapter = null;
    if(manga.chapters && manga.chapters.length){
      // exact match first
      matchedChapter = manga.chapters.find(c => String(c.chapterId) === chapterParam || (c.internalId && `${c.chapterNum},${c.internalId}` === chapterParam));
      if(!matchedChapter){
        // if chapterParam contains comma but chapters stored as "190,103" maybe some mismatch: try find by internal id
        if(chapterParam.includes(',')){
          const parts = chapterParam.split(',');
          const display = parts[0];
          const internal = parts[1];
          matchedChapter = manga.chapters.find(c => (c.internalId && String(c.internalId) === String(internal)) || (String(c.chapterNum) === String(display)));
        } else {
          // numeric match by chapterNum
          const n = Number(chapterParam);
          if(!Number.isNaN(n)) matchedChapter = manga.chapters.find(c => typeof c.chapterNum === 'number' && Math.abs(c.chapterNum - n) < 1e-6 );
        }
      }
      // fallback: contains text
      if(!matchedChapter) matchedChapter = manga.chapters.find(c => c.title && c.title.includes(chapterParam));
      if(matchedChapter) chapterLink = matchedChapter.link;
    }

    if(chapterLink){
      const pages = await extractReaderPages(chapterLink);
      if(pages && pages.length) return res.json({ ok:true, method:'explicit', pages, pageCount: pages.length, matchedChapter });
    }

    // fallback: if manga.internalId present, try CDN discovery using internal id
    const uid = manga.internalId || null;
    const mangaName = manga.title || slug;
    if(uid){
      const pageCount = await discoverPageCountByHead({ uid, mangaName, chapter: chapterParam }).catch(()=>null);
      if(pageCount && pageCount > 0){
        const pages = []; for(let i=1;i<=pageCount;i++) pages.push(buildFallbackPageUrl({ uid, mangaName, chapter: chapterParam, page:i }));
        return res.json({ ok:true, method:'fallback-discovered', pages, pageCount, matchedChapter: matchedChapter || null });
      } else {
        const guessed = []; const guessCount = 25; for(let i=1;i<=guessCount;i++) guessed.push(buildFallbackPageUrl({ uid, mangaName, chapter: chapterParam, page:i }));
        return res.json({ ok:true, method:'fallback-guess', pages: guessed, note:'could not discover exact pageCount', matchedChapter: matchedChapter || null });
      }
    }

    return res.status(422).json({ ok:false, error:'Could not extract pages. Ensure slug correct or site uses JS-heavy reader.' });
  }catch(e){ logErr(e,'/api/reader'); return res.status(500).json({ ok:false, error: e.message }); }
}

/* popular & recommendations */
app.get('/api/popular', async (req,res)=>{ try{ const count = Math.max(1, Math.min(Number(req.query.count)||MAX_POPULAR, MAX_POPULAR)); const items = await fetchPopularItems(count); return res.json({ ok:true, count: items.length, items }); }catch(e){ logErr(e,'/api/popular'); return res.status(500).json({ ok:false, error: e.message||'internal' }); } });

app.get('/api/recommendations', async (req,res)=>{
  try{
    const want = Math.max(1, Math.min(Number(req.query.count)||5, 5));
    const poolPages = Math.max(1, Math.min(Number(req.query.pool_pages)||3, 20));
    const pool = await fetchHomePages(poolPages, 1000);
    if(!pool.length) return res.json({ ok:true, date:null, count:0, items:[] });
    const now = new Date();
    const seedStr = `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
    const seed = Number(seedStr);
    const shuffled = seededShuffle(pool, seed);
    const picks = shuffled.slice(0, Math.min(want, shuffled.length));
    return res.json({ ok:true, date:seedStr, poolPages, poolSize: pool.length, count: picks.length, items: picks });
  }catch(e){ logErr(e,'/api/recommendations'); return res.status(500).json({ ok:false, error: e.message||'internal' }); }
});

/* health & SPA */
app.get('/reader', (req,res) => res.sendFile(path.join(__dirname, 'public', 'reader.html')));
app.get('/', (req,res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));
app.get('/api/health', (req,res) => res.json({ ok:true, ts: Date.now() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, ()=> console.log(`Server listening on ${PORT}`));
