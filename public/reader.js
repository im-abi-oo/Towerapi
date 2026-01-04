// public/reader.js
// Exposes window.ManhwaReader with open({slug,chapter,title,pages,containerId,thumbListId})
(function(){
  const state = {
    pages: [], index: 0, mode: 'scroll', zoom: 1, twoPage:false,
    containerId: 'readerPages', thumbListId: 'thumbList', preloaded: new Set()
  };

  // utility
  function el(tag, cls){ const d = document.createElement(tag); if(cls) d.className = cls; return d; }
  function qs(id){ return document.getElementById(id); }
  function lazyLoadImg(img){
    if(img.dataset.src){ img.src = img.dataset.src; img.removeAttribute('data-src'); }
  }

  // render pages (scroll mode)
  function renderScroll(){
    const c = qs(state.containerId);
    c.innerHTML = '';
    for(let i=0;i<state.pages.length;i++){
      const p = state.pages[i];
      const img = el('img');
      img.dataset.idx = i;
      img.dataset.src = p;
      img.loading = 'lazy';
      img.style.transition = 'transform .15s';
      img.style.transform = `scale(${state.zoom})`;
      img.addEventListener('click', ()=> { state.index = i; highlightThumb(); if(state.mode==='paged') renderPaged(); });
      c.appendChild(img);
      // preload first couple
      if(i<3) { img.src = p; state.preloaded.add(p); }
    }
    // lazy init observer
    const imgs = c.querySelectorAll('img[data-src]');
    if('IntersectionObserver' in window){
      const obs = new IntersectionObserver((entries, o)=>{
        entries.forEach(en => { if(en.isIntersecting){ lazyLoadImg(en.target); o.unobserve(en.target); }});
      }, {root:c, rootMargin:'200px'});
      imgs.forEach(i => obs.observe(i));
    } else imgs.forEach(i => lazyLoadImg(i));
    renderThumbs();
  }

  // paged mode
  function renderPaged(){
    const c = qs(state.containerId);
    c.innerHTML = '';
    const wrapper = el('div','paged-wrap');
    wrapper.style.display = 'flex'; wrapper.style.justifyContent='center'; wrapper.style.alignItems='center'; wrapper.style.height='100%';
    const left = el('button'); left.textContent = '◀'; left.className = 'btn'; left.onclick = prevPage;
    const right = el('button'); right.textContent = '▶'; right.className='btn'; right.onclick = nextPage;
    const img = el('img'); img.id = 'pagedImage'; img.style.maxWidth = state.twoPage ? 'calc(50% - 6px)' : '100%';
    img.src = state.pages[state.index] || '';
    wrapper.appendChild(left); wrapper.appendChild(img); wrapper.appendChild(right);
    c.appendChild(wrapper);
    renderThumbs();
  }

  function renderThumbs(){
    const t = qs(state.thumbListId);
    if(!t) return;
    t.innerHTML = '';
    state.pages.forEach((p,i)=>{
      const d = el('div'); d.style.marginBottom='8px';
      const img = el('img'); img.src = p; img.style.width = '100%'; img.style.objectFit='cover'; img.style.maxHeight='80px';
      img.onclick = ()=> { state.index = i; if(state.mode==='paged') renderPaged(); else window.scrollTo({ top: i*320, behavior:'smooth' }); highlightThumb(); };
      d.appendChild(img);
      if(i === state.index) d.style.outline = '2px solid rgba(124,92,255,0.25)';
      t.appendChild(d);
    });
  }

  function highlightThumb(){
    const t = qs(state.thumbListId);
    if(!t) return;
    Array.from(t.children).forEach((c,i)=> c.style.outline = (i===state.index)? '2px solid rgba(124,92,255,0.25)' : 'none');
  }

  function prevPage(){ if(state.index>0){ state.index--; renderPaged(); highlightThumb(); } }
  function nextPage(){ if(state.index < state.pages.length-1){ state.index++; renderPaged(); highlightThumb(); } }

  // controls bindings (zoom, mode, twoPage)
  function bindControls(){
    const modeSel = qs('readerMode');
    const zoomRange = qs('zoomRange');
    const fitBtn = qs('fitWidth');
    const twoPageBtn = qs('twoPage');
    const jumpStart = qs('jumpStart');

    if(modeSel) modeSel.value = state.mode;
    if(modeSel) modeSel.onchange = (e)=> { state.mode = e.target.value; persistMode(); if(state.mode==='paged') renderPaged(); else renderScroll(); };
    if(zoomRange) zoomRange.oninput = (e)=> { state.zoom = Number(e.target.value); applyZoom(); };
    if(fitBtn) fitBtn.onclick = ()=> { applyFitWidth(); };
    if(twoPageBtn) twoPageBtn.onclick = ()=> { state.twoPage = !state.twoPage; renderPaged(); };
    if(jumpStart) jumpStart.onclick = ()=> { state.index = 0; if(state.mode==='paged') renderPaged(); else window.scrollTo({ top:0, behavior:'smooth' }); highlightThumb(); };
  }

  function applyZoom(){
    if(state.mode==='scroll'){
      const c = qs(state.containerId);
      c.querySelectorAll('img').forEach(img => img.style.transform = `scale(${state.zoom})`);
    } else {
      const img = qs('pagedImage');
      if(img) img.style.transform = `scale(${state.zoom})`;
    }
  }
  function applyFitWidth(){
    if(state.mode==='scroll'){
      const c = qs(state.containerId);
      c.querySelectorAll('img').forEach(img => { img.style.width='100%'; img.style.transform = `scale(1)`; });
    } else {
      const img = qs('pagedImage'); if(img) { img.style.width='100%'; img.style.transform=`scale(1)`; }
    }
  }

  function persistMode(){ localStorage.setItem('manhwa_reader_mode', state.mode); }
  function loadMode(){ const m = localStorage.getItem('manhwa_reader_mode'); if(m) state.mode = m; }

  // preload neighbors
  function smartPreload(centerIdx){
    [centerIdx-1, centerIdx+1].forEach(i => {
      if(i>=0 && i<state.pages.length){
        const url = state.pages[i];
        if(!state.preloaded.has(url)){
          const im = new Image(); im.src = url; im.onload = ()=> state.preloaded.add(url);
        }
      }
    });
  }

  // open API
  async function open(opts){
    // opts: {slug, chapter, title, pages, containerId, thumbListId}
    state.containerId = opts.containerId || state.containerId;
    state.thumbListId = opts.thumbListId || state.thumbListId;
    state.pages = Array.isArray(opts.pages) ? opts.pages.slice() : [];
    state.index = 0;
    loadMode();
    bindControls();

    // if no pages provided, try to fetch (robust)
    if(!state.pages.length){
      try{
        const q = `/api/reader?slug=${encodeURIComponent(opts.slug)}&chapter=${encodeURIComponent(opts.chapter)}`;
        const res = await fetch(q).then(r=>r.json());
        if(res && res.pages && res.pages.length) state.pages = res.pages.slice();
      }catch(e){}
    }

    if(!state.pages.length){
      const container = qs(state.containerId);
      container.innerHTML = '<div class="center muted">صفحه‌ای برای نمایش وجود ندارد</div>';
      return;
    }

    // render
    if(state.mode==='paged') renderPaged(); else renderScroll();
    highlightThumb();
    smartPreload(state.index);

    // keyboard handling
    window.addEventListener('keydown', onKey);
    // touch swipe (simple)
    let startX = null;
    const cont = qs(state.containerId);
    if(cont){
      cont.addEventListener('touchstart', e=> startX = e.touches[0].clientX);
      cont.addEventListener('touchend', e=>{
        if(startX === null) return;
        const dx = e.changedTouches[0].clientX - startX;
        if(Math.abs(dx) > 60){
          if(dx < 0) nextPage(); else prevPage();
        }
        startX = null;
      });
    }

    // save progress periodically
    setInterval(()=> {
      localStorage.setItem(`manhwa_progress_${opts.slug}_${opts.chapter}`, JSON.stringify({idx: state.index, ts: Date.now()}));
    }, 2000);
  }

  function onKey(e){
    if(e.key === 'ArrowRight' || e.key === 'PageDown') nextPage();
    if(e.key === 'ArrowLeft' || e.key === 'PageUp') prevPage();
    if(e.key === 'Escape') close();
  }

  function close(){
    window.removeEventListener('keydown', onKey);
    // clear container?
    const c = qs(state.containerId); if(c) c.innerHTML = '';
    const t = qs(state.thumbListId); if(t) t.innerHTML = '';
  }

  // expose
  window.ManhwaReader = { open, close, state };
})();
