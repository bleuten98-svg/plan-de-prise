/* Plan de prise — application (PWA). Tout est local : aucune donnée n'est envoyée sur Internet. */
(function () {
  'use strict';

  const APP_VERSION = '0.1.0';
  const E = window.OrdoEngine;
  const C = window.OrdoCore;
  const $ = (s, el) => (el || document).querySelector(s);
  const $$ = (s, el) => Array.from((el || document).querySelectorAll(s));
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  const TABLE_KEY = 'ordo.table.v1';

  const S = {
    idx: null, table: E.newTable(), items: [], remarks: [], pages: 0,
    worker: null, workerPromise: null, cur: null, offlineReady: false, ready: false,
    stream: null, view: 'home', lastBlob: null, lastName: '',
  };
  let uidn = 0;
  const uid = () => 'm' + ++uidn;
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  /* ------------------------------------------------------------------ utilitaires d'interface */
  let toastTimer = null;
  function toast(msg, ms) {
    const t = $('#toast');
    t.textContent = msg; t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.hidden = true; }, ms || 3000);
  }

  const TITLES = {
    home: 'Plan de prise', camera: 'Photo', crop: 'Zone de prescription', working: 'Lecture…',
    review: 'Vérification', result: 'Plan prêt', table: 'Table de correspondance', about: 'À propos',
  };
  function show(v) {
    $$('[data-view]').forEach((s) => { s.hidden = s.dataset.view !== v; });
    S.view = v;
    $('#title').textContent = TITLES[v] || 'Plan de prise';
    if (typeof window.scrollTo === 'function') { try { window.scrollTo(0, 0); } catch (e) { /* jsdom */ } }
    if (v !== 'camera') stopCamera();
    if (v === 'home') updateHome();
    if (v === 'review') renderReview();
    if (v === 'table') renderTable();
    if (v === 'about') renderAbout();
  }
  function setProgress(txt, p) {
    $('#work-text').textContent = txt;
    if (p != null) $('#work-bar').value = p;
  }
  function setStatus(txt) { $('#status-text').textContent = txt; }

  /* ------------------------------------------------------------------ stockage de la table (sans donnée patient) */
  function loadTable() {
    try { const t = localStorage.getItem(TABLE_KEY); if (t) return E.parseCsv(t); } catch (e) { /* ignoré */ }
    return null;
  }
  function saveTable() {
    try {
      localStorage.setItem(TABLE_KEY, E.toCsv(S.table));
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
      return true;
    } catch (e) { toast('Table non enregistrée (stockage bloqué ou plein)'); return false; }
  }

  /* ------------------------------------------------------------------ démarrage */
  async function boot() {
    registerSW();
    try {
      const r = await fetch('data/bdpm_light.json');
      S.idx = E.createIndex(await r.json());
      const saved = loadTable();
      if (saved) S.table = saved;
      else {
        const rs = await fetch('data/connaissances_depart.csv');
        S.table = E.parseCsv(await rs.text());
        saveTable();
      }
      S.ready = true;
      updateStatus();
    } catch (e) {
      setStatus('Erreur au chargement de la base des médicaments. Rechargez la page.');
    }
    warmUp();
  }
  function updateStatus(extra) {
    const parts = [];
    if (S.ready) parts.push(`Base BDPM : ${S.idx.products.length.toLocaleString('fr-FR')} spécialités · Table : ${S.table.rows.length} entrées`);
    if (extra) parts.push(extra);
    else if (S.offlineReady) parts.push('Prêt, fonctionne sans réseau.');
    else parts.push('Préparation de la lecture hors ligne…');
    setStatus(parts.join(' — '));
  }
  function registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const had = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.register('sw.js').catch(() => {});
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (had && !window.__reloading) { window.__reloading = true; location.reload(); }
    });
  }

  /* ------------------------------------------------------------------ OCR (Tesseract.js, local) */
  function getWorker() {
    if (S.worker) return Promise.resolve(S.worker);
    if (S.workerPromise) return S.workerPromise;
    const base = new URL('.', location.href).href;
    S.workerPromise = window.Tesseract.createWorker('fra', 1, {
      workerPath: base + 'vendor/tesseract/worker.min.js',
      corePath: base + 'vendor/tesseract/',
      langPath: base + 'vendor/tessdata',
      gzip: false,
      logger: (m) => { if (S.view === 'working' && typeof m.progress === 'number') $('#work-bar').value = m.progress; },
    }).then((w) => { S.worker = w; return w; }).catch((e) => { S.workerPromise = null; throw e; });
    return S.workerPromise;
  }
  async function warmUp() {
    try { await getWorker(); S.offlineReady = true; updateStatus(); }
    catch (e) { updateStatus('Lecture des photos indisponible : connectez-vous une première fois pour la préparer.'); }
  }

  /* ------------------------------------------------------------------ images */
  function makeCanvas(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function freeCanvas(c) { if (c) { c.width = 0; c.height = 0; } }
  function scaleCanvas(src, maxSide) {
    const sc = Math.min(1, maxSide / Math.max(src.width, src.height));
    const c = makeCanvas(Math.round(src.width * sc), Math.round(src.height * sc));
    c.getContext('2d').drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
  function bitmapToCanvas(bmp, maxSide) {
    const sc = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
    const c = makeCanvas(Math.round(bmp.width * sc), Math.round(bmp.height * sc));
    c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
    return c;
  }
  /* niveaux de gris + étirement du contraste (1 % – 99 %) */
  function enhance(c) {
    const ctx = c.getContext('2d');
    const id = ctx.getImageData(0, 0, c.width, c.height);
    const d = id.data, n = d.length / 4;
    const g = new Uint8Array(n), hist = new Uint32Array(256);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const y = ((d[i] * 299 + d[i + 1] * 587 + d[i + 2] * 114) / 1000) | 0;
      g[p] = y; hist[y]++;
    }
    let acc = 0, lo = 0, hi = 255;
    for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc >= n * 0.01) { lo = v; break; } }
    acc = 0;
    for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc >= n * 0.01) { hi = v; break; } }
    const k = 255 / Math.max(40, hi - lo);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
      const v = Math.max(0, Math.min(255, ((g[p] - lo) * k) | 0));
      d[i] = d[i + 1] = d[i + 2] = v;
    }
    ctx.putImageData(id, 0, 0);
  }
  function rotateCanvas(src) {
    const c = makeCanvas(src.height, src.width);
    const x = c.getContext('2d');
    x.translate(c.width, 0); x.rotate(Math.PI / 2); x.drawImage(src, 0, 0);
    return c;
  }
  function cropCanvas(src, r) {
    const up = r.w < 1100 ? Math.min(2, 1100 / r.w) : 1;
    const out = makeCanvas(Math.round(r.w * up), Math.round(r.h * up));
    out.getContext('2d').drawImage(src, r.x, r.y, r.w, r.h, 0, 0, out.width, out.height);
    return out;
  }
  function discardPhoto() {
    if (S.cur) { freeCanvas(S.cur.canvas); S.cur = null; }
    const cv = $('#crop-canvas'); cv.width = 1; cv.height = 1;
  }

  /* ------------------------------------------------------------------ caméra */
  async function startCamera() {
    show('camera');
    const err = $('#cam-error'); err.hidden = true;
    try {
      S.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 4096 }, height: { ideal: 3072 } }, audio: false,
      });
      const v = $('#video'); v.srcObject = S.stream;
      await v.play().catch(() => {});
    } catch (e) {
      err.textContent = 'Caméra indisponible (' + (e && e.name ? e.name : 'erreur') + '). Utilisez « Choisir une photo existante » depuis l’accueil.';
      err.hidden = false;
    }
  }
  function stopCamera() {
    if (S.stream) { S.stream.getTracks().forEach((t) => t.stop()); S.stream = null; }
    const v = $('#video'); if (v) v.srcObject = null;
  }
  async function shoot() {
    const track = S.stream && S.stream.getVideoTracks()[0];
    let bmp = null;
    if (track && 'ImageCapture' in window) {
      try { bmp = await createImageBitmap(await new window.ImageCapture(track).takePhoto()); } catch (e) { bmp = null; }
    }
    if (!bmp) {
      const v = $('#video');
      if (!v.videoWidth) { toast('La caméra n’est pas prête'); return; }
      const c = makeCanvas(v.videoWidth, v.videoHeight);
      c.getContext('2d').drawImage(v, 0, 0);
      bmp = await createImageBitmap(c); freeCanvas(c);
    }
    stopCamera();
    await handleImage(bmp);
  }

  /* ------------------------------------------------------------------ photo -> zone -> lecture */
  async function handleImage(bmp) {
    show('working'); setProgress('Préparation de l’image…', 0);
    try {
      const c = bitmapToCanvas(bmp, 2400);
      if (bmp.close) bmp.close();
      enhance(c);
      S.cur = { canvas: c, rect: null };
      await runAutoZone();
      show('crop'); drawCrop();
    } catch (e) {
      console.error(e);
      discardPhoto();
      toast('Lecture impossible : ' + (e && e.message ? e.message : 'erreur'), 5000);
      show(S.items.length ? 'review' : 'home');
    }
  }
  async function runAutoZone() {
    if (!S.cur) return;
    setProgress('Recherche de la zone de prescription…', 0);
    const full = S.cur.canvas;
    const small = scaleCanvas(full, 1400);
    const sw = small.width, sh = small.height, sc = full.width / sw;
    const w = await getWorker();
    await w.setParameters({ tessedit_pageseg_mode: '11' });
    const r = await w.recognize(small, {}, { blocks: true });
    freeCanvas(small);
    const z = C.detectZone(C.flattenWords(r.data), sw, sh);
    if (z.foundOrdo) {
      S.cur.rect = { x: z.x * sc, y: z.y * sc, w: z.w * sc, h: z.h * sc };
      $('#crop-hint').textContent = 'Zone détectée sous « ORDONNANCE ». Ajustez le cadre si besoin (sans l’en-tête patient).';
    } else {
      S.cur.rect = { x: 0.04 * full.width, y: 0.18 * full.height, w: 0.92 * full.width, h: 0.64 * full.height };
      $('#crop-hint').textContent = 'Zone non détectée : placez le cadre autour des médicaments prescrits (sans l’en-tête patient).';
    }
  }

  /* recadrage tactile */
  let drag = null;
  function drawCrop() {
    const src = S.cur.canvas, cv = $('#crop-canvas');
    const sc = Math.min(1, 1100 / src.width);
    cv.width = Math.round(src.width * sc); cv.height = Math.round(src.height * sc);
    const g = cv.getContext('2d');
    g.drawImage(src, 0, 0, cv.width, cv.height);
    const r = S.cur.rect, x = r.x * sc, y = r.y * sc, w = r.w * sc, h = r.h * sc;
    g.fillStyle = 'rgba(0,0,0,.55)';
    g.fillRect(0, 0, cv.width, y); g.fillRect(0, y + h, cv.width, cv.height - y - h);
    g.fillRect(0, y, x, h); g.fillRect(x + w, y, cv.width - x - w, h);
    g.strokeStyle = '#2e9cff'; g.lineWidth = Math.max(3, cv.width / 250); g.strokeRect(x, y, w, h);
    g.fillStyle = '#2e9cff';
    const rad = Math.max(10, cv.width / 38);
    [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].forEach(([cx, cy]) => { g.beginPath(); g.arc(cx, cy, rad, 0, 7); g.fill(); });
  }
  function cropPoint(e) {
    const cv = $('#crop-canvas'), b = cv.getBoundingClientRect(), src = S.cur.canvas;
    return { x: ((e.clientX - b.left) / b.width) * src.width, y: ((e.clientY - b.top) / b.height) * src.height, k: src.width / b.width };
  }
  function cropDown(e) {
    if (!S.cur) return;
    const p = cropPoint(e), r = S.cur.rect, tol = 40 * p.k;
    const corners = { tl: [r.x, r.y], tr: [r.x + r.w, r.y], bl: [r.x, r.y + r.h], br: [r.x + r.w, r.y + r.h] };
    let best = null, bd = tol;
    for (const [k, [cx, cy]] of Object.entries(corners)) { const d = Math.hypot(p.x - cx, p.y - cy); if (d < bd) { bd = d; best = k; } }
    if (best) drag = { mode: best };
    else if (p.x > r.x && p.x < r.x + r.w && p.y > r.y && p.y < r.y + r.h) drag = { mode: 'move', dx: p.x - r.x, dy: p.y - r.y };
    if (drag) { e.preventDefault(); $('#crop-canvas').setPointerCapture(e.pointerId); }
  }
  function cropMove(e) {
    if (!drag || !S.cur) return;
    e.preventDefault();
    const p = cropPoint(e), r = S.cur.rect, W = S.cur.canvas.width, H = S.cur.canvas.height, min = 60;
    const px = Math.max(0, Math.min(W, p.x)), py = Math.max(0, Math.min(H, p.y));
    let x0 = r.x, y0 = r.y, x1 = r.x + r.w, y1 = r.y + r.h;
    if (drag.mode === 'move') {
      x0 = Math.max(0, Math.min(W - r.w, p.x - drag.dx)); y0 = Math.max(0, Math.min(H - r.h, p.y - drag.dy));
      x1 = x0 + r.w; y1 = y0 + r.h;
    } else {
      if (drag.mode[1] === 'l') x0 = Math.min(px, x1 - min); else x1 = Math.max(px, x0 + min);
      if (drag.mode[0] === 't') y0 = Math.min(py, y1 - min); else y1 = Math.max(py, y0 + min);
    }
    S.cur.rect = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    drawCrop();
  }
  function cropUp() { drag = null; }

  async function readZone() {
    if (!S.cur) return;
    const r = S.cur.rect;
    show('working'); setProgress('Lecture de l’ordonnance…', 0);
    try {
      const crop = cropCanvas(S.cur.canvas, { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h) });
      const w = await getWorker();
      await w.setParameters({ tessedit_pageseg_mode: '6' });
      const res = await w.recognize(crop);
      freeCanvas(crop);
      discardPhoto();
      ingestText(res.data.text);
    } catch (e) {
      console.error(e);
      toast('Lecture impossible : ' + (e && e.message ? e.message : 'erreur'), 5000);
      if (S.cur) { show('crop'); drawCrop(); } else show(S.items.length ? 'review' : 'home');
    }
  }

  /* ------------------------------------------------------------------ lignes de médicaments */
  function toUi(it) {
    return {
      id: uid(), nom: it.nom, dci: it.dci, cat: it.cat,
      matin: it.matin, midi: it.midi, soir: it.soir, coucher: it.coucher,
      posologie: it.posologie || '', utilite: it.utilite || '',
      conseilOrdo: it.conseilOrdo || '', conseilHabituel: it.conseilTable || '',
      match: it.match, flags: it.flags.slice(), source: it.source || '', totalParJour: it.totalParJour,
      verifie: false, memoriser: !!(it.match && it.match.found) && !it.connu,
    };
  }
  function refreshDup() {
    const groups = new Map();
    for (const it of S.items) {
      it.flags = it.flags.filter((f) => f !== 'doublon_substance');
      if (it.match && it.match.found) {
        const k = it.match.dciKey;
        if (!groups.has(k)) groups.set(k, []);
        groups.get(k).push(it);
      }
    }
    for (const g of groups.values()) if (g.length > 1) g.forEach((it) => it.flags.push('doublon_substance'));
  }
  function ingestText(text) {
    const res = E.readPrescription(text, S.idx, S.table);
    S.pages++;
    res.items.forEach((it) => S.items.push(toUi(it)));
    res.remarks.forEach((r) => S.remarks.push(r));
    refreshDup();
    if (!res.items.length) toast('Aucun médicament repéré : ajustez la zone ou ajoutez-les à la main.', 5000);
    show('review');
  }
  function findItem(id) { return S.items.find((i) => i.id === id); }

  function cardHtml(it) {
    const q = it.cat === 'quotidien';
    const flags = it.flags.map((f) => `<li>${esc(E.FLAG_LABELS[f] || f)}</li>`).join('');
    const cls = it.verifie ? 'is-ok' : it.flags.length ? 'is-warn' : '';
    const hintTot = q && it.totalParJour && ![it.matin, it.midi, it.soir, it.coucher].some((v) => String(v).trim()) ? `<p class="hint">L’ordonnance indique ${esc(it.totalParJour)} par jour : répartissez dans les cases.</p>` : '';
    const dose = (k, lab) => `<div><label>${lab}</label><input type="text" inputmode="decimal" data-f="${k}" value="${esc(it[k])}" aria-label="${lab}"></div>`;
    const opts = [['quotidien', 'Tous les jours'], ['besoin', 'Si besoin'], ['autre', 'Autre fréquence']]
      .map(([v, l]) => `<option value="${v}"${it.cat === v ? ' selected' : ''}>${l}</option>`).join('');
    return `<article class="med ${cls}" data-id="${it.id}">
      <div class="med-head"><div class="grow">
        <label>Médicament</label><input type="text" class="nom" data-f="nom" value="${esc(it.nom)}">
        <label>Substance</label><input type="text" class="dci" data-f="dci" value="${esc(it.dci)}">
      </div><button class="del" data-act="del" aria-label="Supprimer ce médicament">🗑</button></div>
      ${flags ? `<ul class="flags">${flags}</ul>` : ''}
      <label>Catégorie</label><select data-f="cat">${opts}</select>
      ${q ? `${hintTot}<div class="doses">${dose('matin', 'Matin')}${dose('midi', 'Midi')}${dose('soir', 'Soir')}${dose('coucher', 'Coucher')}</div>`
        : `<label>Posologie (texte libre)</label><textarea data-f="posologie">${esc(it.posologie)}</textarea>`}
      <label>À quoi sert le traitement ?</label><input type="text" data-f="utilite" value="${esc(it.utilite)}">
      <label>Conseil habituel (mémorisable)</label><input type="text" data-f="conseilHabituel" value="${esc(it.conseilHabituel)}">
      <label>Précision de cette ordonnance (durée, conseils)</label><input type="text" data-f="conseilOrdo" value="${esc(it.conseilOrdo)}">
      ${it.match && it.match.found ? `<label class="check"><input type="checkbox" data-f="memoriser"${it.memoriser ? ' checked' : ''}> Retenir l’utilité et le conseil habituel pour ce médicament</label>` : ''}
      <label class="check verif"><input type="checkbox" data-f="verifie"${it.verifie ? ' checked' : ''}> Vérifié avec l’ordonnance</label>
      ${it.source ? `<details class="src"><summary>Texte lu sur l’ordonnance</summary><p>${esc(it.source)}</p></details>` : ''}
    </article>`;
  }
  function renderReview() {
    $('#cards').innerHTML = S.items.map(cardHtml).join('') || '<div class="card center"><p>Aucun médicament pour l’instant.</p></div>';
    const rem = $('#remarks');
    if (S.remarks.length) {
      rem.hidden = false;
      rem.innerHTML = '<strong>Remarques lues sur l’ordonnance</strong> (non reprises dans le plan) :<ul>' + S.remarks.map((r) => `<li>${esc(r)}</li>`).join('') + '</ul>';
    } else rem.hidden = true;
    updateRevStatus();
  }
  function rerenderCard(it) {
    const el = $(`article[data-id="${it.id}"]`);
    if (!el) return renderReview();
    el.outerHTML = cardHtml(it);
    updateRevStatus();
  }
  function updateRevStatus() {
    const n = S.items.length, ok = S.items.filter((i) => i.verifie).length;
    $('#rev-status').textContent = n ? `${ok} / ${n} ligne${n > 1 ? 's' : ''} vérifiée${ok > 1 ? 's' : ''}` : 'Ajoutez un médicament ou une autre ordonnance.';
    $('#rev-generate').disabled = !(n > 0 && ok === n);
  }
  function rematch(it) {
    const m = E.matchDrug(S.idx, it.nom, '');
    it.flags = it.flags.filter((f) => !['medicament_non_reconnu', 'lecture_incertaine', 'forme_ambigue'].includes(f));
    if (m.found) {
      it.match = m; it.nom = m.display; it.dci = m.dci ? `(${m.dci})` : '';
      const k = E.lookup(S.table, m);
      if (k) {
        if (!it.utilite) it.utilite = k.utilite || '';
        if (!it.conseilHabituel) it.conseilHabituel = k.conseil || '';
        it.memoriser = false;
      } else it.memoriser = true;
      if (m.confidence === 'faible') it.flags.push('lecture_incertaine');
      if (m.ambiguousForm) it.flags.push('forme_ambigue');
    } else {
      it.match = { found: false }; it.memoriser = false; it.flags.push('medicament_non_reconnu');
    }
    refreshDup();
    renderReview();
  }

  function onCardInput(e) {
    const f = e.target.dataset && e.target.dataset.f;
    const art = e.target.closest('article[data-id]');
    if (!f || !art) return;
    const it = findItem(art.dataset.id);
    if (!it) return;
    if (e.target.type === 'checkbox') {
      it[f] = e.target.checked;
      if (f === 'verifie') { art.classList.toggle('is-ok', it.verifie); art.classList.toggle('is-warn', !it.verifie && it.flags.length > 0); updateRevStatus(); }
    } else if (f !== 'cat') {
      it[f] = e.target.value;
      if (it.verifie && f !== 'nom') { /* une modification invalide la vérification */ }
    }
  }
  function onCardChange(e) {
    const f = e.target.dataset && e.target.dataset.f;
    const art = e.target.closest('article[data-id]');
    if (!f || !art) return;
    const it = findItem(art.dataset.id);
    if (!it) return;
    if (e.target.type === 'checkbox') { onCardInput(e); return; }
    if (f === 'cat') { it.cat = e.target.value; it.verifie = false; rerenderCard(it); }
    else if (f === 'nom') { it.nom = e.target.value; it.verifie = false; rematch(it); }
    else if (e.target.type !== 'checkbox') { if (it.verifie) { it.verifie = false; art.classList.remove('is-ok'); const cb = $('input[data-f="verifie"]', art); if (cb) cb.checked = false; updateRevStatus(); } }
  }
  function onCardClick(e) {
    const b = e.target.closest('[data-act="del"]');
    if (!b) return;
    const art = b.closest('article[data-id]');
    const it = findItem(art.dataset.id);
    if (it && window.confirm(`Supprimer « ${it.nom || 'ce médicament'} » du plan ?`)) {
      S.items = S.items.filter((x) => x !== it); refreshDup(); renderReview();
    }
  }

  function addManual(text) {
    const m = E.matchDrug(S.idx, text, '');
    const it = {
      id: uid(), cat: 'quotidien', matin: '', midi: '', soir: '', coucher: '', posologie: '', utilite: '',
      conseilOrdo: '', conseilHabituel: '', source: '', totalParJour: null, verifie: false, flags: ['posologie_absente'],
      nom: text, dci: '', match: { found: false }, memoriser: false,
    };
    if (m.found) {
      it.match = m; it.nom = m.display; it.dci = m.dci ? `(${m.dci})` : '';
      const k = E.lookup(S.table, m);
      if (k) {
        it.utilite = k.utilite || ''; it.conseilHabituel = k.conseil || '';
        if (k.categorie_defaut) it.cat = k.categorie_defaut;
        if (k.posologie_defaut) {
          const p = E.parsePosology(k.posologie_defaut);
          if (p.doses) { it.cat = 'quotidien'; ['matin', 'midi', 'soir', 'coucher'].forEach((s) => { it[s] = p.doses[s] === 0.5 ? '½' : String(p.doses[s]); }); }
          else it.posologie = p.posologie;
          it.flags = ['posologie_par_defaut'];
        }
      } else it.memoriser = true;
    } else it.flags.push('medicament_non_reconnu');
    S.items.push(it); refreshDup(); renderReview();
  }

  /* ------------------------------------------------------------------ génération du Word */
  async function generate() {
    if (!S.items.length) return;
    const vides = S.items.filter((i) => i.cat === 'quotidien' && ![i.matin, i.midi, i.soir, i.coucher].some((v) => String(v).trim() !== ''));
    if (vides.length && !window.confirm(`Cases horaires vides pour : ${vides.map((i) => i.nom).join(', ')}.\nGénérer quand même ?`)) return;
    const btn = $('#rev-generate'); btn.disabled = true;
    try {
      for (const it of S.items) {
        if (it.memoriser && it.match && it.match.found && (it.utilite || it.conseilHabituel)) {
          E.remember(S.table, it.match, {
            utilite: it.utilite || '', conseil: it.conseilHabituel || '',
            categorie_defaut: it.cat !== 'quotidien' ? it.cat : undefined,
          });
        }
      }
      saveTable();
      const now = new Date();
      const buf = await (await fetch('modele/Modele_plan_de_prise.docx')).arrayBuffer();
      const doc = new window.docxtemplater(new window.PizZip(buf), { paragraphLoop: true, linebreaks: true });
      doc.render(C.planDataFromItems(S.items, now.toLocaleDateString('fr-FR')));
      S.lastBlob = doc.getZip().generate({ type: 'blob', mimeType: DOCX_MIME });
      const p2 = (n) => String(n).padStart(2, '0');
      S.lastName = `Plan_de_prise_${now.getFullYear()}-${p2(now.getMonth() + 1)}-${p2(now.getDate())}_${p2(now.getHours())}${p2(now.getMinutes())}.docx`;
      $('#res-name').textContent = S.lastName;
      show('result');
    } catch (e) {
      console.error(e);
      toast('Génération impossible : ' + (e && e.message ? e.message : 'erreur'), 6000);
    } finally { btn.disabled = false; updateRevStatus(); }
  }
  function downloadBlob(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000);
  }
  async function shareBlob(blob, name, mime, title) {
    const f = new File([blob], name, { type: mime });
    if (navigator.canShare && navigator.canShare({ files: [f] })) {
      try { await navigator.share({ files: [f], title }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
    }
    downloadBlob(blob, name);
    toast('Fichier enregistré dans les téléchargements');
  }

  function endSession() {
    if (!window.confirm('Effacer le plan en cours ? Les lignes non générées seront perdues.')) return;
    S.items = []; S.remarks = []; S.pages = 0; S.lastBlob = null; S.lastName = '';
    discardPhoto();
    show('home');
  }

  /* ------------------------------------------------------------------ accueil */
  function updateHome() {
    const r = $('#home-resume');
    r.hidden = !S.items.length;
    if (S.items.length) $('#home-count').textContent = `Plan en cours : ${S.items.length} médicament${S.items.length > 1 ? 's' : ''} (${S.pages} ordonnance${S.pages > 1 ? 's' : ''})`;
    if (S.ready) updateStatus();
  }

  /* ------------------------------------------------------------------ table de correspondance */
  const labelOf = (r) => (r.cle.startsWith('marque:') ? (r.marque || r.cle.slice(7)) + ' (marque)' : r.dci || r.cle);
  function renderTable() {
    const q = E.normName($('#tab-search').value || '');
    const rows = S.table.rows
      .filter((r) => !q || E.normName([r.cle, r.marque, r.dci, r.utilite, r.conseil].join(' ')).includes(q))
      .sort((a, b) => labelOf(a).localeCompare(labelOf(b), 'fr'));
    $('#tab-list').innerHTML = rows.map((r) =>
      `<button class="entry" data-cle="${esc(r.cle)}"><b>${esc(labelOf(r))}</b><span>${esc(r.utilite || '—')}${r.conseil ? ' · ' + esc(r.conseil) : ''}</span></button>`).join('')
      || '<p class="hint center">Aucune entrée.</p>';
    $('#tab-count').textContent = `${S.table.rows.length} entrée${S.table.rows.length > 1 ? 's' : ''} — touchez une ligne pour la modifier`;
  }
  let editing = null;
  function openEntry(cle) {
    const row = S.table.rows.find((r) => r.cle === cle);
    if (!row) return;
    editing = row;
    const f = $('#entry-form');
    $('#entry-title').textContent = labelOf(row);
    ['marque', 'dci', 'utilite', 'conseil', 'posologie_defaut', 'categorie_defaut'].forEach((k) => { f.elements[k].value = row[k] || ''; });
    $('#dlg-entry').showModal();
  }
  function closeEntry() {
    const dlg = $('#dlg-entry'), f = $('#entry-form'), v = dlg.returnValue;
    if (editing && v === 'save') {
      ['marque', 'dci', 'utilite', 'conseil', 'posologie_defaut', 'categorie_defaut'].forEach((k) => { editing[k] = f.elements[k].value.trim(); });
      editing.maj = new Date().toISOString().slice(0, 10);
      saveTable(); toast('Entrée enregistrée');
    } else if (editing && v === 'delete') {
      if (window.confirm('Supprimer cette entrée de la table ?')) { S.table.rows = S.table.rows.filter((r) => r !== editing); saveTable(); }
    }
    editing = null; renderTable();
  }
  async function importCsv(file) {
    try {
      const t = E.parseCsv(await file.text());
      if (!t.rows.length || !('cle' in t.rows[0])) { toast('Fichier non reconnu : colonne « cle » manquante', 5000); return; }
      let n = 0;
      for (const r of t.rows) {
        if (!r.cle) continue;
        const i = S.table.rows.findIndex((x) => E.normName(x.cle) === E.normName(r.cle));
        if (i >= 0) S.table.rows[i] = Object.assign(S.table.rows[i], r); else S.table.rows.push(r);
        n++;
      }
      saveTable(); renderTable(); toast(`${n} entrée${n > 1 ? 's' : ''} importée${n > 1 ? 's' : ''}`);
    } catch (e) { toast('Import impossible', 4000); }
  }
  async function addSeed() {
    try {
      const t = E.parseCsv(await (await fetch('data/connaissances_depart.csv')).text());
      let n = 0;
      for (const r of t.rows) if (!S.table.rows.some((x) => E.normName(x.cle) === E.normName(r.cle))) { S.table.rows.push(r); n++; }
      saveTable(); renderTable(); toast(n ? `${n} entrée${n > 1 ? 's' : ''} ajoutée${n > 1 ? 's' : ''}` : 'Rien à ajouter');
    } catch (e) { toast('Table de départ introuvable', 4000); }
  }

  /* ------------------------------------------------------------------ à propos */
  async function renderAbout() {
    let persisted = '—';
    try { if (navigator.storage && navigator.storage.persisted) persisted = (await navigator.storage.persisted()) ? 'oui' : 'non'; } catch (e) { /* ignoré */ }
    $('#about-info').innerHTML = `<h2>Informations</h2>
      <p>Version de l’application : <strong>${APP_VERSION}</strong></p>
      <p>Base BDPM : <strong>${S.idx ? S.idx.products.length.toLocaleString('fr-FR') : '—'}</strong> spécialités (extraction du ${esc(S.idx ? S.idx.version : '—')})</p>
      <p>Table de correspondance : <strong>${S.table.rows.length}</strong> entrées (stockage protégé : ${persisted})</p>
      <p>Lecture hors ligne : <strong>${S.offlineReady ? 'prête' : 'en préparation'}</strong></p>`;
  }
  async function checkUpdate() {
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) { toast('Mise à jour non disponible ici'); return; }
      await reg.update();
      toast('Vérification effectuée : l’application se met à jour si nécessaire');
    } catch (e) { toast('Impossible de vérifier (hors ligne ?)'); }
  }

  /* ------------------------------------------------------------------ branchements */
  function init() {
    $('#btn-home').addEventListener('click', () => show('home'));
    $('#btn-table').addEventListener('click', () => show('table'));
    $('#btn-about').addEventListener('click', () => show('about'));

    $('#btn-camera').addEventListener('click', startCamera);
    $('#btn-resume').addEventListener('click', () => show('review'));
    $('#file-input').addEventListener('change', async (e) => {
      const f = e.target.files && e.target.files[0]; e.target.value = '';
      if (!f) return;
      try { await handleImage(await createImageBitmap(f)); } catch (err) { toast('Image illisible', 4000); }
    });
    $('#cam-cancel').addEventListener('click', () => show(S.items.length ? 'review' : 'home'));
    $('#cam-shoot').addEventListener('click', shoot);

    const cv = $('#crop-canvas');
    cv.addEventListener('pointerdown', cropDown);
    cv.addEventListener('pointermove', cropMove);
    cv.addEventListener('pointerup', cropUp);
    cv.addEventListener('pointercancel', cropUp);
    $('#crop-rotate').addEventListener('click', async () => {
      if (!S.cur) return;
      const old = S.cur.canvas; S.cur.canvas = rotateCanvas(old); freeCanvas(old);
      show('working'); await runAutoZone().catch(() => {}); show('crop'); drawCrop();
    });
    $('#crop-auto').addEventListener('click', async () => { if (!S.cur) return; show('working'); await runAutoZone().catch(() => {}); show('crop'); drawCrop(); });
    $('#crop-all').addEventListener('click', () => { if (!S.cur) return; const c = S.cur.canvas; S.cur.rect = { x: 0, y: 0, w: c.width, h: c.height }; drawCrop(); });
    $('#crop-cancel').addEventListener('click', () => { discardPhoto(); show(S.items.length ? 'review' : 'home'); });
    $('#crop-go').addEventListener('click', readZone);

    const cards = $('#cards');
    cards.addEventListener('input', onCardInput);
    cards.addEventListener('change', onCardChange);
    cards.addEventListener('click', onCardClick);
    $('#rev-camera').addEventListener('click', startCamera);
    $('#rev-add').addEventListener('click', () => { $('#add-form').reset(); $('#dlg-add').showModal(); });
    $('#dlg-add').addEventListener('close', () => {
      const d = $('#dlg-add');
      if (d.returnValue === 'add') { const t = $('#add-form').elements.nom.value.trim(); if (t) addManual(t); }
      d.returnValue = '';
    });
    $('#rev-generate').addEventListener('click', generate);

    $('#res-share').addEventListener('click', () => S.lastBlob && shareBlob(S.lastBlob, S.lastName, DOCX_MIME, 'Plan de prise'));
    $('#res-download').addEventListener('click', () => S.lastBlob && downloadBlob(S.lastBlob, S.lastName));
    $('#res-back').addEventListener('click', () => show('review'));
    $('#res-end').addEventListener('click', endSession);

    $('#tab-search').addEventListener('input', renderTable);
    $('#tab-list').addEventListener('click', (e) => { const b = e.target.closest('.entry'); if (b) openEntry(b.dataset.cle); });
    $('#dlg-entry').addEventListener('close', closeEntry);
    $('#tab-export').addEventListener('click', () => shareBlob(new Blob([E.toCsv(S.table)], { type: 'text/csv' }), 'connaissances.csv', 'text/csv', 'Table de correspondance'));
    $('#tab-import-input').addEventListener('change', (e) => { const f = e.target.files && e.target.files[0]; e.target.value = ''; if (f) importCsv(f); });
    $('#tab-seed').addEventListener('click', addSeed);
    $('#about-update').addEventListener('click', checkUpdate);

    document.addEventListener('visibilitychange', () => { if (document.hidden) stopCamera(); });
    boot();
  }

  window.__ordo = { S, E, C, ingestText, generate, show, renderReview, addManual, toUi, rematch, saveTable };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
