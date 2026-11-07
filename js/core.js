/* Fonctions pures de l'appli (testables sous Node) : détection de la zone de prescription, assemblage des lignes. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrdoCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const norm = (t) => String(t || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z]/g, '');
  function lev(a, b) {
    const m = a.length, n = b.length;
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }

  /* Résultat Tesseract.js (blocks) -> liste de mots {text, bbox} */
  function flattenWords(data) {
    const words = [];
    for (const b of (data && data.blocks) || [])
      for (const p of b.paragraphs || []) for (const l of p.lines || []) for (const w of l.words || []) words.push(w);
    return words;
  }

  /* Zone utile = sous le mot « ORDONNANCE », au-dessus de la signature, à droite de la colonne des praticiens */
  function detectZone(words, W, H) {
    const ords = words.filter((w) => { const n = norm(w.text); return n.length >= 8 && lev(n, 'ordonnance') <= 2; })
      .sort((a, b) => a.bbox.y0 - b.bbox.y0);
    if (!ords.length) return { x: 0, y: 0, w: W, h: H, foundOrdo: false, foundSig: false };
    const o = ords[0];
    const y0 = Math.min(H, o.bbox.y1 + 0.009 * H);
    const sigs = words.filter((w) => {
      const n = norm(w.text);
      const isDoc = n === 'dr' || n === 'docteur' || (n.length >= 6 && n.endsWith('teur') && lev(n, 'docteur') <= 2) || (n.length >= 5 && lev(n, 'docteur') <= 1);
      return isDoc && w.bbox.y0 > y0 + 0.035 * H && w.bbox.x0 > 0.2 * W;
    });
    const y1 = sigs.length ? Math.min(...sigs.map((s) => s.bbox.y0)) - 0.002 * H : Math.min(H, y0 + 0.4 * H);
    const x0 = Math.max(0, o.bbox.x0 - 0.25 * W);
    const x1 = 0.97 * W;
    return { x: Math.round(x0), y: Math.round(y0), w: Math.round(x1 - x0), h: Math.round(Math.max(40, y1 - y0)), foundOrdo: true, foundSig: sigs.length > 0 };
  }

  /* Conseil final = précisions de l'ordonnance + conseil habituel (dédoublonnés) */
  function joinConseil(ordo, habituel) {
    const out = [];
    for (const part of [ordo, habituel]) {
      for (const c of String(part || '').split(/\s*;\s*/)) {
        const t = c.trim();
        if (t && !out.some((x) => x.toLowerCase() === t.toLowerCase())) out.push(t);
      }
    }
    return out.join(' ; ');
  }

  /* Ligne éditée à l'écran -> données du modèle Word */
  function rowFromItem(it) {
    const q = it.cat === 'quotidien';
    return {
      nom: it.nom || '', dci: it.dci || '',
      matin: q ? it.matin || '' : '', midi: q ? it.midi || '' : '', soir: q ? it.soir || '' : '', coucher: q ? it.coucher || '' : '',
      posologie: q ? '' : it.posologie || '',
      utilite: it.utilite || '', conseil: joinConseil(it.conseilOrdo, it.conseilHabituel),
    };
  }
  function planDataFromItems(items, date) {
    const pick = (c) => items.filter((i) => i.cat === c).map(rowFromItem);
    return { date_bilan: date, quotidien: pick('quotidien'), besoin: pick('besoin'), autre: pick('autre'), arretes: '' };
  }

  return { flattenWords, detectZone, joinConseil, rowFromItem, planDataFromItems, norm, lev };
});
