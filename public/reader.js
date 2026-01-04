// public/reader.js
(function(){
  const DEFAULT_CONTAINER = 'imageContainer';
  let state = { slug:null, chapter:null, pages:[], idx:0, mode:'scroll', sizePct:75, highQ:false, containerId: DEFAULT_CONTAINER, preloaded:new Set() };

  function qs(id){ return document.getElementById(id); }
  function el(tag, cls){ const d=document.createElement(tag); if(cls) d.className=cls; return d; }

  function applySize(img){
    img.style.width = state.sizePct + '%';
  }

  async function fetchPagesFromApi(slug, chapter){
    try{
      const q = `/api/reader?slug=${encodeURIComponent(slug)}&chapter=${encodeURIComponent(chapter)}`;
      const res = await fetch(q).then(r=>r.json());
      return (res && res.pages) || [];
    }catch(e){ return []; }
  }

  function renderScroll(){
    const root = qs(state.containerId);
    root.innerHTML = '';
    state.pages.forEach((p,i)=>{
      const img = el('img'); img.className = 'manhwa-image'; img.dataset.idx = i; img.loading = 'lazy';
      img.src = p;
      applySize(img);
      img.addEventListener('click', ()=>{ /* toggle toolbar? */ });
      root.appendChild(img);
      if(i<3) preloadUrl(p);
    });
  }

  function renderPaged(){
    const root = qs(state.containerId);
    root.innerHTML = '';
    const box = el('div'); box.style.display='flex'; box.style.justifyContent='center'; box.style.alignItems='center';
    const left = el('button'); left.className='btn'; left.textContent='◀'; left.onclick = prevPage;
    const right = el('button'); right.className='btn'; right.textContent='▶'; right.onclick = nextPage;
    const img = el('img'); img.id='pagedImage'; img.style.maxWidth = '100%'; img.src = state.pages[state.idx] || '';
    box.appendChild(left); box.appendChild(img); box.appendChild(right);
    root.appendChild(box);
    applySize(img);
    preloadNeighbors();
  }

  function preloadUrl(u){ if(!u || state.preloaded.has(u)) return; const im = new Image(); im.src = u; im.onload = ()=> state.preloaded.add(u); }
  function preloadNeighbors(){ preloadUrl(state.pages[state.idx-1]); preloadUrl(state.pages[state.idx+1]); }

  function nextPage(){ if(state.idx < state.pages.length-1){ state.idx++; if(state.mode==='paged') renderPaged(); saveProgress(); } }
  function prevPage(){ if(state.idx > 0){ state.idx--; if(state.mode==='paged') renderPaged(); saveProgress(); } }

  function saveProgress(){ try{ localStorage.setItem(`manhwa_progress_${state.slug}_${state.chapter}`, JSON.stringify({ idx: state.idx, ts: Date.now() })); }catch(e){} }
  function loadProgress(){ try{ const s = localStorage.getItem(`manhwa_progress_${state.slug}_${state.chapter}`); if(s){ const p = JSON.parse(s); if(typeof p.idx==='number') state.idx = p.idx; } }catch(e){} }

  function bindControls(){
    const slider = qs('imageSizeSlider'); const sizeValue = qs('sizeValue'); const serverSel = qs('serverSelect'); const highQ = qs('highQuality'); const modeBtn = qs('modeToggle'); const fitBtn = qs('fitBtn'); const backBtn = qs('backBtn'); const prevBtn = qs('prevBtn'); const nextBtn = qs('nextBtn');

    if(slider){ slider.value = state.sizePct; sizeValue.textContent = state.sizePct; slider.oninput = (e)=>{ state.sizePct = Number(e.target.value); sizeValue.textContent = state.sizePct; // apply
      document.querySelectorAll(`#${state.containerId} img`).forEach(img=>applySize(img)); }; }
    if(serverSel) serverSel.onchange = ()=> reloadPages();
    if(highQ) highQ.onchange = ()=> { state.highQ = highQ.checked; reloadPages(); };
    if(modeBtn) modeBtn.onclick = ()=> { state.mode = (state.mode==='scroll'?'paged':'scroll'); modeBtn.textContent = state.mode==='scroll' ? 'حالت: عمودی' : 'حالت: کتابی'; render(); };
    if(fitBtn) fitBtn.onclick = ()=> { document.querySelectorAll(`#${state.containerId} img`).forEach(img=>{ img.style.width = '100%'; }); };
    if(backBtn) backBtn.onclick = ()=> { window.history.back(); };
    if(prevBtn) prevBtn.onclick = ()=> { window.location.href = `/reader?slug=${encodeURIComponent(state.slug)}&chapter=${encodeURIComponent(getPrevChapterParam())}`; };
    if(nextBtn) nextBtn.onclick = ()=> { window.location.href = `/reader?slug=${encodeURIComponent(state.slug)}&chapter=${encodeURIComponent(getNextChapterParam())}`; };
  }

  // placeholder prev/next logic: find around current chapter in DOM? we can't know easily here; server could return matchedChapter with link to prev/next - but we try to parse matchedChapter if available in pages fetch - fallback: disable
  function getPrevChapterParam(){ return (state.prevChapterParam) ? state.prevChapterParam : ''; }
  function getNextChapterParam(){ return (state.nextChapterParam) ? state.nextChapterParam : ''; }

  async function reloadPages(){
    // re-fetch using same slug/chapter (server chooses server)
    const pages = await fetchPagesFromApi(state.slug, state.chapter);
    if(pages && pages.length){ state.pages = pages; render(); }
  }

  function render(){
    if(state.mode==='paged') renderPaged(); else renderScroll();
  }

  async function open(opts){
    // opts: { slug, chapter, containerId, pages (optional), controls }
    state.slug = opts.slug; state.chapter = opts.chapter; state.containerId = opts.containerId || DEFAULT_CONTAINER;
    state.mode = localStorage.getItem('manhwa_reader_mode') || 'scroll';
    state.sizePct = Number(localStorage.getItem('manhwa_image_size') || 75);
    state.highQ = false;

    bindControls();

    if(Array.isArray(opts.pages) && opts.pages.length){
      state.pages = opts.pages.slice();
    } else {
      state.pages = await fetchPagesFromApi(state.slug, state.chapter);
    }

    // if API returned matchedChapter info with prev/next in metadata, handle
    // (server currently returns matchedChapter only; if needed, extend server to include prev/next ids)

    if(!state.pages.length){
      qs(state.containerId).innerHTML = '<div class="center">صفحه‌ای برای نمایش وجود ندارد یا استخراج شده نیست.</div>';
      return;
    }

    loadProgress();
    render();
    // keyboard
    document.onkeydown = function(e){ if(e.key==='ArrowRight' || e.key==='PageDown') nextPage(); if(e.key==='ArrowLeft' || e.key==='PageUp') prevPage(); if(e.key==='Escape') window.history.back(); };
    // touch
    let startX=null;
    const root = qs(state.containerId);
    root.addEventListener('touchstart', e=> startX = e.touches[0].clientX);
    root.addEventListener('touchend', e=>{
      if(startX===null) return; const dx = e.changedTouches[0].clientX - startX; if(Math.abs(dx) > 60){ if(dx < 0) nextPage(); else prevPage(); } startX = null;
    });
  }

  // expose API
  window.ManhwaReader = { open, close: ()=>{ document.onkeydown=null; }, state };
})();
