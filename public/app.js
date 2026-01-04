// public/app.js
const $app = document.getElementById('app');
const API = '/api';

document.getElementById('homeBtn').addEventListener('click', ()=> { setActive('home'); showHome(); });
document.getElementById('genresBtn').addEventListener('click', ()=> { setActive('genres'); showGenres(); });
document.getElementById('recBtn').addEventListener('click', ()=> { setActive('rec'); showRecs(); });
document.getElementById('btnSearch').addEventListener('click', searchHandler);

function setActive(key){
  document.querySelectorAll('.nav button').forEach(b => b.classList.remove('active'));
  if(key==='home') document.getElementById('homeBtn').classList.add('active');
  if(key==='genres') document.getElementById('genresBtn').classList.add('active');
  if(key==='rec') document.getElementById('recBtn').classList.add('active');
}

async function showHome(){
  $app.innerHTML = '<div class="center">در حال بارگذاری...</div>';
  const resp = await fetch(`${API}/home?page=1`).then(r=>r.json()).catch(()=>null);
  const pop = await fetch(`${API}/popular?count=8`).then(r=>r.json()).catch(()=>null);
  const items = (resp && resp.items) || [];
  const popular = (pop && pop.items) || [];
  $app.innerHTML = `
    <section class="section">
      <h3>محبوب</h3>
      <div class="grid">${popular.map(ci=>card(ci)).join('')}</div>
    </section>
    <section class="section">
      <h3>جدیدها</h3>
      <div class="grid">${items.map(ci=>card(ci)).join('')}</div>
    </section>
  `;
  bindCards();
}

async function showGenres(){
  $app.innerHTML = '<div class="center">در حال بارگذاری...</div>';
  const res = await fetch(`${API}/genres?pages=1`).then(r=>r.json()).catch(()=>null);
  const genres = (res && res.genres) || [];
  $app.innerHTML = `<div class="section"><h3>ژانرها</h3><div style="display:flex;gap:8px;flex-wrap:wrap">${genres.map(g=>`<button class="tag" data-slug="${g.slug}">${g.name}</button>`).join('')}</div></div><div id="genreGrid"></div>`;
  document.querySelectorAll('.tag').forEach(t=> t.addEventListener('click', async (e)=>{
    const slug = e.target.dataset.slug;
    document.getElementById('genreGrid').innerHTML = '<div class="center">در حال بارگذاری...</div>';
    const r = await fetch(`${API}/genre/${encodeURIComponent(slug)}?pages=2`).then(r=>r.json()).catch(()=>null);
    const items = (r && r.items) || [];
    document.getElementById('genreGrid').innerHTML = `<div class="grid">${items.map(ci=>card(ci)).join('')}</div>`;
    bindCards();
  }));
}

async function showRecs(){
  $app.innerHTML = '<div class="center">در حال بارگذاری...</div>';
  const r = await fetch(`${API}/recommendations?count=8&pool_pages=3`).then(r=>r.json()).catch(()=>null);
  const items = (r && r.items) || [];
  $app.innerHTML = `<section class="section"><h3>پیشنهادات روز</h3><div class="grid">${items.map(ci=>card(ci)).join('')}</div></section>`;
  bindCards();
}

function card(ci){
  const slug = ci.slug || (ci.link ? ci.link.split('/').filter(Boolean).pop() : '');
  return `<div class="card" data-slug="${slug}">
    <img src="${ci.cover || '/placeholder.png'}" alt="${ci.title || ''}">
    <div class="meta"><div class="title">${ci.title || ''}</div><div class="sub">${slug}</div></div>
  </div>`;
}

function bindCards(){
  document.querySelectorAll('.card').forEach(c => c.addEventListener('click', ()=>{
    const slug = c.dataset.slug;
    openManga(slug);
  }));
}

async function openManga(slug){
  $app.innerHTML = '<div class="center">در حال بارگذاری جزئیات...</div>';
  const r = await fetch(`${API}/manga/${encodeURIComponent(slug)}`).then(r=>r.json()).catch(()=>null);
  if(!r || !r.ok) { $app.innerHTML = '<div class="center">خطا در دریافت</div>'; return; }
  const m = r.manga;
  $app.innerHTML = `<div class="section"><div class="manga-head"><img src="${m.cover||'/placeholder.png'}" class="manga-cover"><div class="manga-info"><h1>${m.title||''}</h1><div class="muted">${m.description||''}</div><div class="tags">${(m.genres||[]).map(g=>`<span class="tag">${g}</span>`).join('')}</div><div style="margin-top:12px"><button id="openLatest" class="btn">خواندن از آخرین</button></div></div></div></div>
    <div class="section"><h3>فصل‌ها</h3><div class="chapters" id="chapList">${(m.chapters||[]).map(c=>`<div class="ch-item" data-ch="${c.chapterId}"><div>${c.title}</div><div><button class="btn small" data-ch="${c.chapterId}">خواندن</button></div></div>`).join('')}</div></div>`;
  document.getElementById('openLatest').addEventListener('click', ()=> {
    const ch = (m.chapters && m.chapters[0] && m.chapters[0].chapterId) || (m.chapters && m.chapters[0] && m.chapters[0].title) || '1';
    // open reader page with query
    location.href = `/reader?slug=${encodeURIComponent(m.slug||slug)}&chapter=${encodeURIComponent(ch)}`;
  });
  // chapter buttons
  document.querySelectorAll('.ch-item button').forEach(b => b.addEventListener('click', (e)=>{
    const ch = e.target.dataset.ch;
    location.href = `/reader?slug=${encodeURIComponent(m.slug||slug)}&chapter=${encodeURIComponent(ch)}`;
  }));
}

/* search */
async function searchHandler(){
  const q = document.getElementById('search').value.trim();
  if(!q) return;
  const slug = q.replace(/\s+/g,'_');
  // try direct manga slug endpoint
  const r = await fetch(`${API}/manga/${encodeURIComponent(slug)}`).then(r=>r.json()).catch(()=>null);
  if(r && r.ok){ openManga(r.manga.slug); return; }
  // fallback: scan home pages small
  for(let p=1;p<=3;p++){
    const h = await fetch(`${API}/home?page=${p}`).then(r=>r.json()).catch(()=>null);
    if(h && h.items){
      const found = h.items.find(it => (it.title||'').toLowerCase().includes(q.toLowerCase()) || (it.link||'').toLowerCase().includes(q.toLowerCase()));
      if(found){ openManga(found.slug || (found.link.split('/').filter(Boolean).pop())); return; }
    }
  }
  alert('پیدا نشد');
}

/* init */
setActive('home');
showHome();
