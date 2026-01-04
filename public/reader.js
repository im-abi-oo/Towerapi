// public/reader.js
(function(){
  const DEFAULT_CONTAINER = 'readerRoot';
  let state = { pages: [], idx:0, mode:'scroll', zoom:1, twoPage:false, containerId: DEFAULT_CONTAINER, thumbListId: null };

  function el(tag, cls){ const d=document.createElement(tag); if(cls) d.className = cls; return d; }
  function qs(id){ return document.getElementById(id); }

  function applyZoomToAll(){
    const root = qs(state.containerId);
    if(!root) return;
    root.querySelectorAll('img').forEach(img => {
      img.style.transform = `scale(${state.zoom})`;
      img.style.transformOrigin = 'top center';
    });
  }

  function renderScroll(){
    const root = qs(state.containerId);
    root.innerHTML = '';
    state.pages.forEach((p,i)=>{
      const img = el('img');
      img.dataset.idx = i;
      img.loading = 'lazy';
      img.src = p;
      img.style.transition = 'transform .12s';
      img.style.maxWidth = '100%';
      img.style.marginBottom = '12px';
      root.appendChild(img);
    });
    applyZoomToAll();
  }

  function renderPaged(){
    const root = qs(state.containerId);
    root.innerHTML = '';
    const wrap = el('div','paged-wrap');
    wrap.style.display='flex'; wrap.style.justifyContent='center'; wrap.style.alignItems='center';
    const left = el('button'); left.textContent='◀'; left.className='btn'; left.onclick=prev;
    const right = el('button'); right.textContent='▶'; right.className='btn'; right.onclick=next;
    const img = el('img'); img.id='pagedImage'; img.style.maxWidth = state.twoPage ? '48%' : '100%';
    img.src = state.pages[state.idx] || '';
    wrap.appendChild(left); wrap.appendChild(img); wrap.appendChild(right);
    root.appendChild(wrap);
    applyZoomToAll();
  }

  function next(){ if(state.idx < state.pages.length-1) { state.idx++; if(state.mode==='paged') renderPaged(); saveProgress(); } }
  function prev(){ if(state.idx>0){ state.idx--; if(state.mode==='paged') renderPaged(); saveProgress(); } }

  function bindKeys(){
    document.onkeydown = function(e){
      if(e.key==='ArrowRight' || e.key==='PageDown') next();
      if(e.key==='ArrowLeft' || e.key==='PageUp') prev();
      if(e.key==='Escape') close();
    };
  }

  function close(){
    const root = qs(state.containerId);
    if(root) root.innerHTML = '';
    document.onkeydown = null;
  }

  function saveProgress(){
    try{
      const key = `manhwa_progress_${state.slug}_${state.chapter}`;
      localStorage.setItem(key, JSON.stringify({ idx: state.idx, ts: Date.now() }));
    }catch(e){}
  }

  function loadProgress(){
    try{
      const key = `manhwa_progress_${state.slug}_${state.chapter}`;
      const s = localStorage.getItem(key);
      if(s) { const p = JSON.parse(s); if(typeof p.idx === 'number') state.idx = p.idx; }
    }catch(e){}
  }

  async function open(opts){
    // opts: {slug, chapter, containerId, thumbListId}
    state.slug = opts.slug;
    state.chapter = opts.chapter;
    state.containerId = opts.containerId || state.containerId;
    state.thumbListId = opts.thumbListId || state.thumbListId;
    state.mode = localStorage.getItem('manhwa_reader_mode') || 'scroll';
    state.zoom = 1; state.twoPage = false;
    bindKeys();

    const root = qs(state.containerId);
    if(!root) return;

    // try using provided pages first
    if(Array.isArray(opts.pages) && opts.pages.length) {
      state.pages = opts.pages.slice();
    } else {
      // fetch from API
      try{
        const q = `/api/reader?slug=${encodeURIComponent(state.slug)}&chapter=${encodeURIComponent(state.chapter)}`;
        const res = await fetch(q).then(r=>r.json());
        state.pages = (res && res.pages) || [];
      }catch(e){ state.pages = []; }
    }

    if(!state.pages.length){
      root.innerHTML = '<div class="center">صفحه‌ای برای نمایش وجود ندارد یا استخراج نشد.</div>';
      return;
    }

    loadProgress();

    if(state.mode==='paged') renderPaged();
    else renderScroll();

    // simple touch for paged
    let startX = null;
    root.addEventListener('touchstart', e=> startX = e.touches[0].clientX);
    root.addEventListener('touchend', e=>{
      if(startX === null) return;
      const dx = e.changedTouches[0].clientX - startX;
      if(Math.abs(dx) > 60){ if(dx < 0) next(); else prev(); }
      startX = null;
    });

    // simple controls injection
    injectControls();
  }

  function injectControls(){
    // add small controls overlay
    const root = qs(state.containerId);
    if(!root) return;
    let overlay = document.getElementById('readerControlsOverlay');
    if(overlay) overlay.remove();
    overlay = el('div'); overlay.id = 'readerControlsOverlay';
    overlay.style.position='fixed'; overlay.style.bottom='12px'; overlay.style.left='50%'; overlay.style.transform='translateX(-50%)'; overlay.style.zIndex=9999;
    overlay.style.display='flex'; overlay.style.gap='8px';
    const btnZoomIn = el('button'); btnZoomIn.className='btn'; btnZoomIn.textContent = '+';
    const btnZoomOut = el('button'); btnZoomOut.className='btn'; btnZoomOut.textContent='-';
    const btnMode = el('button'); btnMode.className='btn'; btnMode.textContent = state.mode==='scroll' ? 'Paged' : 'Scroll';
    const btnFit = el('button'); btnFit.className='btn'; btnFit.textContent='Fit';
    btnZoomIn.onclick = ()=> { state.zoom = Math.min(2, state.zoom + 0.1); applyZoomToAll(); };
    btnZoomOut.onclick = ()=> { state.zoom = Math.max(0.5, state.zoom - 0.1); applyZoomToAll(); };
    btnMode.onclick = ()=> { state.mode = state.mode==='scroll' ? 'paged' : 'scroll'; localStorage.setItem('manhwa_reader_mode', state.mode); if(state.mode==='paged') renderPaged(); else renderScroll(); btnMode.textContent = state.mode==='scroll' ? 'Paged' : 'Scroll'; };
    btnFit.onclick = ()=> { // fit width: images width=100%
      const root = qs(state.containerId);
      if(!root) return;
      root.querySelectorAll('img').forEach(img => { img.style.width='100%'; img.style.transform='scale(1)'; });
    };
    overlay.appendChild(btnZoomOut); overlay.appendChild(btnZoomIn); overlay.appendChild(btnFit); overlay.appendChild(btnMode);
    document.body.appendChild(overlay);
  }

  // expose
  window.ManhwaReader = { open, close, state };
})();
