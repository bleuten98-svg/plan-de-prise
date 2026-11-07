/* Moteur de lecture d'ordonnance — sans IA générative, 100 % règles + BDPM.
 * Fonctionne dans le navigateur (window.OrdoEngine) et sous Node (require).
 * Entrée : le texte brut issu de l'OCR (zone de prescription). Sortie : lignes structurées + données du modèle Word.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrdoEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* ------------------------------------------------------------------ outils texte */
  const fold = (s) => [...String(s).normalize('NFC')].map((c) => c.normalize('NFD')[0]).join('').toLowerCase();
  const normName = (s) => fold(s).replace(/[^a-z0-9]+/g, ' ').trim();
  const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
  const sentenceCase = (s) => cap(String(s).toLowerCase().trim());
  const SALTS = '(?:chlorhydrate|sulfate|tartrate|m[ée]silate|bromhydrate|mal[ée]ate|fumarate|citrate|ac[ée]tate|phosphate|val[ée]rate|succinate|b[ée]silate|nitrate|sodique|potassique|calcique)';
  const cleanDci = (n) => n.replace(new RegExp('\\s*\\(' + SALTS + "[^)]*\\)\\s*$", 'i'), '').replace(new RegExp('^' + SALTS + "\\s+(?:de |d')", 'i'), '').trim();
  const QUAL = /\s+(hydrate|anhydre|monohydrate|dihydrate|trihydrate|hemihydrate|sodique|potassique|calcique|chlorhydrate|sulfate)\b.*$/;
  const QUAL_ACC = /\s+(hydrat[ée]|anhydre|monohydrat[ée]|dihydrat[ée]|trihydrat[ée]|h[ée]mihydrat[ée]|sodique|potassique|calcique|chlorhydrate|sulfate)(?![\wÀ-ÿ]).*$/i;

  function lev(a, b) {
    if (a === b) return 0;
    const m = a.length, n = b.length;
    if (!m) return n;
    if (!n) return m;
    let prev = new Array(n + 1), cur = new Array(n + 1);
    for (let j = 0; j <= n; j++) prev[j] = j;
    for (let i = 1; i <= m; i++) {
      cur[0] = i;
      for (let j = 1; j <= n; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[n];
  }
  const sim = (a, b) => 1 - lev(a, b) / Math.max(a.length, b.length);

  const numbers = (s) => (String(s).match(/\d+(?:[.,]\d+)?/g) || []).map((x) => parseFloat(x.replace(',', '.')));

  /* Corrections typiques d'OCR sur de l'imprimé photographié */
  function cleanLine(raw) {
    let s = String(raw).replace(/[|¦]/g, ' ').replace(/\u00a0/g, ' ');
    s = s.replace(/(\d)\s*[.,]\s*[.,]\s*(\d)/g, '$1,$2'); // 2.,5 -> 2,5
    s = s.replace(/(\d)\.(\d)/g, '$1,$2'); // 2.5 -> 2,5 (virgule française)
    s = s.replace(/(^|[\s(])[lI](?=\s*(comprim|g[ée]lule|sachet|cp\b|ampoule|goutte|c[aà]p|suppo))/gi, '$11 '); // lcomprimé -> 1 comprimé
    s = s.replace(/(^|\s)[Oo](?=\d)/g, '$10'); // O5 -> 05
    s = s.replace(/\s+/g, ' ').trim();
    return s;
  }
  const letters = (s) => (s.match(/[A-Za-zÀ-ÿ]/g) || []).length;

  /* ------------------------------------------------------------------ index BDPM */
  function createIndex(data) {
    const products = data.p.map(([cis, denom, forme, voie, subs]) => {
      const head = denom.split(/,\s/)[0];
      const toks = normName(head).split(' ');
      const bi = toks.findIndex((t) => /\d/.test(t));
      const brandToks = bi < 0 ? toks : toks.slice(0, bi);
      return {
        cis, denom, forme, voie,
        subs: subs.map(([n, d]) => ({ nom: n, dosage: d })),
        first: brandToks[0] || '',
        nums: numbers(head),
      };
    });
    const byBrand = new Map(), bySub = new Map();
    const push = (m, k, v) => { if (!k) return; if (!m.has(k)) m.set(k, []); m.get(k).push(v); };
    for (const p of products) {
      push(byBrand, p.first, p);
      for (const s of p.subs) {
        const k = normName(s.nom).replace(QUAL, '');
        s.key = k;
        push(bySub, k, p);
      }
    }
    return { products, byBrand, bySub, brandNames: [...byBrand.keys()], subNames: [...bySub.keys()], version: data.version };
  }

  /* Recherche d'un nom (marque ou substance), tolérante aux erreurs d'OCR */
  function findName(idx, word) {
    const q = normName(word);
    if (q.length < 4) return null;
    const exactSub = idx.bySub.has(q), exactBrand = idx.byBrand.has(q);
    if (exactSub) return { type: 'dci', key: q, score: 1 };
    if (exactBrand) return { type: 'brand', key: q, score: 1 };
    let best = null;
    const scan = (names, type) => {
      for (const n of names) {
        if (Math.abs(n.length - q.length) > 2) continue;
        const sc = sim(q, n);
        if (sc >= 0.84 && (!best || sc > best.score)) best = { type, key: n, score: sc };
      }
    };
    scan(idx.subNames, 'dci');
    scan(idx.brandNames, 'brand');
    return best;
  }

  /* ------------------------------------------------------------------ en-tête d'un médicament */
  const UNIT = '(?:%|mg|g|µg|mcg|microgrammes?|ui|u\\.?\\s?i\\.?|ml|mui|mu|u\\.?\\s?ceip)';
  function parseHeader(h) {
    let s = h.replace(/\s+/g, ' ').trim();
    const alts = [];
    s = s.replace(/\(([^)]*)\)/g, (m, g) => { alts.push(g.trim()); return ' '; }).replace(/\s+/g, ' ').trim();
    const re = new RegExp('(?<![A-Za-zÀ-ÿ])\\d[\\d,]*\\s*' + UNIT + '?(?:\\s*/\\s*\\d[\\d,]*\\s*' + UNIT + '?)*', 'i');
    const m = re.exec(s);
    const name = (m ? s.slice(0, m.index) : s).replace(/[:\-–—\s]+$/, '').trim();
    let dosage = m ? m[0].trim() : '';
    dosage = dosage.replace(/\s*%/g, ' %').replace(/(\d)\s*(mg|g|ml|µg|mcg)\b/gi, '$1 $2').replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
    const form = (m ? s.slice(m.index + m[0].length) : '').replace(/:/g, ' ').trim();
    return { name, alts, dosage, nums: numbers(dosage), form };
  }

  function titleName(name) {
    return name.split(/\s+/).map((t, i) => {
      if (i === 0) return cap(t.toLowerCase());
      return t.length <= 3 && t === t.toUpperCase() ? t : t.toLowerCase();
    }).join(' ');
  }

  /* Rapprochement d'un en-tête avec la BDPM */
  function matchDrug(idx, header, hint) {
    const h = parseHeader(header);
    const cands = [];
    for (const a of h.alts) { const w = a.split(/\s+/)[0]; if (w) cands.push({ word: w, alt: true }); }
    const first = h.name.split(/\s+/)[0];
    if (first) cands.push({ word: first, alt: false });
    let hit = null;
    const mainF = first ? findName(idx, first) : null;
    // « SPIRONOLACTONE (ALDACTONE) » : la marque entre parenthèses est plus précise que la substance écrite devant
    // « MOVICOL (Macrogol) » : le nom de marque écrit devant reste prioritaire
    const altOk = !mainF || mainF.type === 'dci' || mainF.score < 0.9;
    for (const c of cands) {
      const f = c.alt ? findName(idx, c.word) : mainF;
      if (!f) continue;
      if (c.alt && !altOk) continue;
      if (c.alt && f.type === 'brand' && f.score >= 0.9) { hit = { ...f, written: c.word }; break; }
      if (!hit || f.score > hit.score) hit = { ...f, written: c.word };
    }
    if (!hit) return { found: false, header: h, display: titleName(h.name || header), dosage: h.dosage };

    const pool = hit.type === 'brand' ? idx.byBrand.get(hit.key) : idx.bySub.get(hit.key);
    const formHint = fold(h.form + ' ' + (hint || ''));
    const scored = pool.map((p) => {
      let dos = 0;
      if (h.nums.length) {
        const pn = new Set(p.nums);
        for (const s of p.subs) numbers(s.dosage).forEach((x) => pn.add(x));
        dos = h.nums.filter((n) => pn.has(n)).length;
      }
      const f0 = fold(p.forme).split(' ')[0];
      const frm = f0 && formHint.includes(f0) ? 1 : 0;
      const single = p.subs.length === 1 ? 1 : 0;
      return { p, dos, frm, single };
    });
    scored.sort((a, b) => b.dos - a.dos || b.frm - a.frm || (hit.type === 'dci' ? b.single - a.single : 0) || a.p.denom.length - b.p.denom.length);
    const top = scored[0];
    const tied = scored.filter((x) => x.dos === top.dos && x.frm === top.frm);
    const forms = new Set(tied.map((x) => x.p.forme));

    const dciNames = top.p.subs.map((s) => sentenceCase(cleanDci(s.nom.replace(/\s+/g, ' ').toLowerCase().replace(QUAL_ACC, ''))));
    const dciUniq = [...new Set(dciNames)];
    const display = (titleName(hit.written || h.name) + (h.dosage ? ' ' + h.dosage : '')).trim();
    const dciTxt = dciUniq.join(' / ');
    const sameAsName = fold(dciTxt) === fold(titleName(hit.written || ''));
    const dciKey = [...new Set(top.p.subs.map((s) => s.key))].sort().join(' + ');

    let confidence = 'haute';
    if (hit.score < 0.95) confidence = 'moyenne';
    if (hit.score < 0.9 || (h.nums.length && top.dos === 0)) confidence = 'faible';
    if (hit.type === 'dci' && confidence === 'haute') confidence = 'moyenne'; // générique : plusieurs marques possibles

    return {
      found: true, via: hit.type, score: +hit.score.toFixed(2), confidence,
      cis: top.p.cis, denomination: top.p.denom, forme: top.p.forme, voie: top.p.voie,
      brandKey: hit.type === 'brand' ? hit.key : '',
      dciKey, display, dci: sameAsName ? '' : dciTxt, dciFull: dciTxt, dosage: h.dosage,
      ambiguousForm: forms.size > 1 && !formHint.trim(), header: h,
    };
  }

  /* ------------------------------------------------------------------ posologie */
  const QTY = '(\\d+(?:[.,]\\d+)?|1\\s*/\\s*2|½|un|une|deux|trois)';
  const UNITS = '(?:comprim[ée]s?|g[ée]lules?|cp\\b|sachets?|ampoules?|c[aà]p(?:sules?)?\\.?|doses?|gouttes?|cuill[eè]res?(?:\\s+[àa]\\s+(?:caf[ée]|soupe))?|suppositoires?|patchs?|pulv[ée]risations?|injections?)';
  const WORDNUM = { un: 1, une: 1, deux: 2, trois: 3, '½': 0.5 };
  const qtyVal = (t) => {
    const k = t.toLowerCase().replace(/\s+/g, '');
    if (WORDNUM[k] != null) return WORDNUM[k];
    if (k === '1/2') return 0.5;
    return parseFloat(k.replace(',', '.'));
  };
  const showQty = (v) => (v === 0.5 ? '½' : String(v));
  const SLOTS = ['matin', 'midi', 'soir', 'coucher'];
  const SPREAD = { 1: ['matin'], 2: ['matin', 'soir'], 3: ['matin', 'midi', 'soir'], 4: ['matin', 'midi', 'soir', 'coucher'] };

  const CONSEILS = [
    [/\bau cours (?:des|du) repas|\bpendant (?:les |le )?repas/i, 'Au cours des repas'],
    [/(?<![\wÀ-ÿ])[àa] jeun\b/i, 'À jeun'],
    [/\bavant (?:les |le |chaque )?repas/i, 'Avant les repas'],
    [/\bapr[èe]s (?:les |le |chaque )?repas/i, 'Après les repas'],
    [/(?<![\wÀ-ÿ])[àa] distance des repas/i, 'À distance des repas'],
    [/\bavec un grand verre d.eau/i, "Avec un grand verre d'eau"],
    [/\b(?:en )?espa[cç](?:ant|er) les prises d.au moins (\d+)\s*(?:heures?|h)\b/i, (m) => `Espacer les prises d'au moins ${m[1]} heures`],
    [/\bmax(?:imum)?\.?\s*(\d+)\s*(?:\/\s*(?:jour|j)\b|par jour)/i, (m) => `Maximum ${m[1]} par jour`],
  ];
  const CONSEIL_SENTENCE = /^(espacer|risque|[ée]viter|attention|ne pas|ne jamais|se laver|conserver|agiter)/i;
  const DISPENSING = /\b(tubes?|bo[iî]tes?|flacons?|conditionnements?|renouvel|quantit[ée])\b/i;
  const BESOIN = /(?<![\wÀ-ÿ])(si\s+(?:besoin|douleurs?|fi[èe]vre|temp[ée]rature|naus[ée]es?|vomissements?|angoisse|toux|crise|n[ée]cessaire|insomnie|constipation|diarrh[ée]e)|en cas de|au besoin|[àa] la demande)/i;
  const COMPLEX = /\bpuis\b|\bsur\s+\d|\bun jour sur|\b1\s*jour sur|\btous les \d+ jours|\bpar semaine|\b(?:1|une|2|deux|3|trois)\s*fois\s*(?:par|\/)\s*(?:semaine|mois)|\bsemaine\b|\bselon (?:le )?sch[ée]ma|\bd[ée]croissan|\bprogressi/i;

  function tidyEnd(s) {
    const keep = new Set(['j', 'h', 'an', 'ans', 'cp', 'mg', 'g', 'ml', 'l', 'x', 'ui']);
    const toks = s.trim().split(/\s+/);
    while (toks.length > 1) {
      const t = toks[toks.length - 1].replace(/[^\wÀ-ÿ]/g, '');
      if (t.length <= 2 && !/\d/.test(t) && !keep.has(t.toLowerCase())) toks.pop();
      else break;
    }
    return toks.join(' ');
  }

  function parsePosology(bodyRaw) {
    const flags = [];
    let body = bodyRaw.replace(/\(\s*\d+\s*(?:bo[iî]tes?|flacons?|tubes?|conditionnements?)\s*\)/gi, ' ')
      .replace(/\s*\/\s*/g, '/').replace(/\s+/g, ' ').trim();
    body = body.replace(/^[^\wÀ-ÿ½]*(?:\b\w{1,2}\b[\s,.;]*)+(?=\d)/, ''); // bruit manuscrit avant le 1er chiffre
    body = body.replace(/\b\d+\s*(?:tubes?|bo[iî]tes?|flacons?)(?:\s*\/\s*mois|\s+par\s+mois)?(?:\s+(?:pendant\s+)?\d+\s*mois)?/gi, ' ').replace(/\s+/g, ' ').trim(); // « 1 tube/mois 6 mois »
    const out = { cat: 'inconnu', doses: null, totalParJour: null, posologie: '', conseils: [], duree: '', flags };

    // durée
    let m = body.match(/\bpendant\s+(?:les\s+)?(\d+)\s*(?:premi[èe]res?\s+)?(jours?|j|semaines?|sem|mois|ans?|heures?|h)\b/i);
    if (!m) m = body.match(/(?:^|\s)(\d+)\s+(jours?|semaines?|mois|ans?)\s*[^\wÀ-ÿ]*(?:\s\S{1,2})?\s*$/i);
    let work = body;
    if (m) {
      const u = m[2].toLowerCase();
      const unit = /^j/.test(u) ? (m[1] === '1' ? 'jour' : 'jours') : /^sem/.test(u) ? (m[1] === '1' ? 'semaine' : 'semaines') : /^h/.test(u) ? (m[1] === '1' ? 'heure' : 'heures') : /^an/.test(u) ? (m[1] === '1' ? 'an' : 'ans') : u;
      out.duree = `${m[1]} ${unit}`;
      work = body;
    }

    // conseils exploités puis retirés du texte libre
    for (const [re, val] of CONSEILS) {
      const mm = work.match(re);
      if (mm) {
        const txt = typeof val === 'function' ? val(mm) : val;
        if (!out.conseils.includes(txt)) out.conseils.push(txt);
        if (/espa|max/i.test(re.source)) work = work.replace(re, ' ').replace(/,\s*,/g, ',');
      }
    }
    // phrases de conseil libres, infos de délivrance
    const sentences = work.split(/(?<=[.;])\s+(?=[A-ZÀ-Ý])|,\s+(?=(?:Risque|Espacer|[ÉE]viter|Attention)\b)|\s+(?=(?:Risque|Espacer)\b)/).map((x) => x.trim()).filter(Boolean);
    const kept = [];
    for (const sx of sentences) {
      if (CONSEIL_SENTENCE.test(sx)) { out.conseils.push(cap(sx.replace(/[.\s]+$/, ''))); continue; }
      if (DISPENSING.test(sx) && !/\d\s*(?:comprim|g[ée]lule)/i.test(sx)) continue;
      kept.push(sx);
    }
    let text = kept.join(' ');
    text = text.replace(/\s+([,.;])/g, '$1').replace(/\s+/g, ' ').replace(/^[,.;:\s]+|[,.;:\s]+$/g, '').trim();
    out.posologie = tidyEnd(text);
    out.posologie = cap(out.posologie.replace(/[.\s]+$/, ''));

    const t = fold(text);
    const core = m ? tidyEnd(body.replace(m[0], ' ').replace(/[^\wÀ-ÿ]+/g, ' ').trim()) : text; // texte sans la durée
    const besoin = BESOIN.test(text);
    const complexe = COMPLEX.test(text);

    // quantité par prise
    const qm = text.match(new RegExp(QTY + '\\s*' + UNITS, 'i'));
    const qty = qm ? qtyVal(qm[1]) : 1;

    // schéma N-N-N(-N)
    const dash = text.match(/(?:^|\s)(\d+(?:[.,]\d+)?|½)\s*[-–]\s*(\d+(?:[.,]\d+)?|½)\s*[-–]\s*(\d+(?:[.,]\d+)?|½)(?:\s*[-–]\s*(\d+(?:[.,]\d+)?|½))?(?=\s|$|[.,])/);
    let doses = null, nPar = null, heures = false;
    if (dash) {
      const v = dash.slice(1, 5).map((x) => (x == null ? 0 : x === '½' ? 0.5 : parseFloat(x.replace(',', '.'))));
      doses = { matin: v[0], midi: v[1], soir: v[2], coucher: v[3] || 0 };
    }
    // fréquence x N/jour, N fois par jour, N/jour, toutes les N heures
    if (!doses) {
      const f = text.match(/(?:x|×)\s*(\d+)\s*\/\s*(?:jour|j|24\s*h(?:eures?)?)/i)
        || text.match(/(\d+)\s*(?:fois|x|prises?)\s*(?:par|\/)\s*(?:jour|j|24\s*h)/i)
        || text.match(/(?:^|\s)(\d+)\s*\/\s*(?:jour|j)\b/i);
      if (f) nPar = parseInt(f[1], 10);
      const hr = text.match(/toutes les\s+(\d+)\s*(?:heures?|h)\b/i);
      if (!nPar && hr) { const hh = parseInt(hr[1], 10); nPar = Math.round(24 / hh); heures = true; }
    }
    // mots-clés horaires
    if (!doses && !nPar) {
      const slots = [];
      if (/\bmatin\b|petit[- ]d[ée]jeuner/i.test(t)) slots.push('matin');
      if (/\bmidi\b|\bd[ée]jeuner\b/i.test(t) && !/petit[- ]d[ée]jeuner/i.test(t.replace(/\bd[ée]jeuner\b/, 'x'))) slots.push('midi');
      if (/\bsoir\b|\bd[iî]ner\b/i.test(t)) slots.push('soir');
      if (/coucher/i.test(t)) slots.push('coucher');
      if (/\bmidi\b/i.test(t) && !slots.includes('midi')) slots.push('midi');
      if (slots.length) {
        doses = { matin: 0, midi: 0, soir: 0, coucher: 0 };
        for (const s of slots) doses[s] = qty;
      }
    }
    // N unités par jour, sans horaire
    let parJour = null;
    if (!doses && !nPar) {
      const pj = text.match(new RegExp(QTY + '\\s*' + UNITS + '\\s*(?:par|/)\\s*(?:jour|j)\\b', 'i')) || text.match(/(?:^|\s)(\d+)\s*(?:par|\/)\s*(?:jour|j)\b/i);
      if (pj) parJour = qtyVal(pj[1]);
    }

    // décisions de catégorie
    const systematique = /syst[ée]matique/i.test(text);
    if ((besoin && (nPar || doses) && /\bpuis\b/i.test(text)) || (besoin && systematique)) {
      out.cat = 'autre'; flags.push('schema_mixte');
    } else if (complexe) {
      out.cat = 'autre'; flags.push('schema_complexe');
    } else if (besoin) {
      out.cat = 'besoin';
    } else if (doses) {
      out.cat = 'quotidien'; out.doses = doses;
    } else if (nPar) {
      if (nPar >= 1 && nPar <= 4) {
        out.cat = 'quotidien';
        out.doses = { matin: 0, midi: 0, soir: 0, coucher: 0 };
        for (const s of SPREAD[nPar]) out.doses[s] = qty;
        if (heures) flags.push('horaires_a_verifier');
      } else { out.cat = 'autre'; flags.push('schema_complexe'); }
    } else if (parJour != null) {
      out.cat = 'quotidien'; out.totalParJour = parJour;
      if (parJour === 1) { out.doses = { matin: 1, midi: 0, soir: 0, coucher: 0 }; flags.push('horaire_a_confirmer'); }
      else flags.push('repartition_a_preciser');
    } else if (!core || !/\d|matin|soir|midi|jour/i.test(core)) {
      out.cat = 'inconnu'; flags.push('posologie_absente');
    } else {
      out.cat = 'autre'; flags.push('schema_complexe');
    }
    return out;
  }

  /* ------------------------------------------------------------------ segmentation de la zone de prescription */
  const REMARK = /^(si arr[êe]t|renouvelable|non substituable|ne pas substituer|nr\b|ald\b|dur[ée]e de traitement|traitement habituel|valable)/i;
  const STOP = new Set(['toilette', 'semaine', 'irritation', 'heures', 'moins', 'appliquer', 'prendre', 'comprime', 'comprimes', 'tube', 'boite', 'renouvelable', 'pendant', 'matin', 'soir', 'midi', 'risque', 'espacer', 'avant', 'apres', 'visage', 'puis', 'ordonnance']);

  function extractZone(text) {
    const lines = String(text).split(/\r?\n/);
    let s = lines.findIndex((l) => /ordonnance/i.test(l));
    s = s < 0 ? 0 : s + 1;
    let e = lines.findIndex((l, k) => k >= s && /^\W*(?:[od]?cteur|docteur|dr)\b/i.test(l.trim()) || /signature|cachet/i.test(l));
    if (e < 0 || e < s) e = lines.length;
    return lines.slice(s, e);
  }

  function detectStart(line, idx) {
    // 1) numérotation « 1)- », « 2) », « )- » (le chiffre peut être perdu par l'OCR)
    const num = line.match(/^[\s]*\(?\d{0,2}\s*[)}\]]+[\s\-–—.:]*([A-Za-zÀ-ÿ].*)$/);
    let rest = null;
    if (num && line.search(/[)}\]]/) <= 6) rest = num[1];
    if (rest == null) {
      const w = line.match(/^([A-ZÀ-Ý][A-Za-zÀ-ÿ'-]{3,})/);
      if (!w || STOP.has(fold(w[1]))) return null;
      const f = findName(idx, w[1]);
      if (!f || f.score < 0.9) return null;
      rest = line;
    }
    // en-tête = avant « : », sinon nom + dosage
    let header, body;
    const colon = rest.indexOf(':');
    if (colon > 0 && colon < 90) { header = rest.slice(0, colon); body = rest.slice(colon + 1); }
    else {
      const re = new RegExp('^([^\\d]*?\\d[\\d,]*\\s*' + UNIT + '?(?:\\s*/\\s*\\d[\\d,]*\\s*' + UNIT + '?)*)(.*)$', 'i');
      const m = rest.match(re);
      if (m) { header = m[1]; body = m[2]; } else { header = rest; body = ''; }
    }
    return { header: header.trim(), body: body.trim() };
  }

  function segment(lines, idx) {
    const items = [], remarks = [];
    let cur = null;
    for (const raw of lines) {
      const line = cleanLine(raw);
      if (!line || letters(line) < 3) continue;
      if (REMARK.test(line)) { remarks.push(line.replace(/[\s:]+$/, '')); cur = null; continue; }
      const st = detectStart(line, idx);
      if (st) { cur = { header: st.header, body: [st.body], lines: [line] }; items.push(cur); }
      else if (cur) { cur.body.push(line); cur.lines.push(line); }
    }
    return { items, remarks };
  }

  /* ------------------------------------------------------------------ table de correspondance (évolutive) */
  const COLS = ['cle', 'marque', 'dci', 'utilite', 'conseil', 'posologie_defaut', 'categorie_defaut', 'maj'];

  function newTable() { return { rows: [] }; }

  function parseCsv(text) {
    text = text.replace(/^\uFEFF/, '');
    const delim = (text.split('\n')[0].match(/;/g) || []).length >= (text.split('\n')[0].match(/,/g) || []).length ? ';' : ',';
    const rows = [];
    let row = [], cur = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (q) {
        if (c === '"' && text[i + 1] === '"') { cur += '"'; i++; }
        else if (c === '"') q = false;
        else cur += c;
      } else if (c === '"') q = true;
      else if (c === delim) { row.push(cur); cur = ''; }
      else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; row.push(cur); rows.push(row); row = []; cur = ''; }
      else cur += c;
    }
    if (cur || row.length) { row.push(cur); rows.push(row); }
    const head = rows.shift().map((h) => h.trim());
    return { rows: rows.filter((r) => r.some((x) => x.trim())).map((r) => Object.fromEntries(head.map((h, i) => [h, (r[i] || '').trim()]))) };
  }

  function toCsv(table) {
    const esc = (v) => { v = v == null ? '' : String(v); return /[;"\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
    return '\uFEFF' + [COLS.join(';')].concat(table.rows.map((r) => COLS.map((c) => esc(r[c])).join(';'))).join('\r\n') + '\r\n';
  }

  /* Clé d'une ligne : marque si l'entrée est propre à une marque, sinon combinaison de substances */
  function lookup(table, match) {
    if (!match || !match.found) return null;
    const byKey = (k) => table.rows.find((r) => normName(r.cle) === normName(k));
    return (match.brandKey && byKey('marque:' + match.brandKey)) || (match.dciKey && byKey(match.dciKey)) || null;
  }

  /* Mémorise (ou met à jour) les champs saisis à l'écran de vérification */
  function remember(table, match, fields, date) {
    if (!match || !match.found) return null;
    const cle = fields.parMarque && match.brandKey ? 'marque:' + match.brandKey : match.dciKey;
    let row = table.rows.find((r) => normName(r.cle) === normName(cle));
    if (!row) { row = { cle }; table.rows.push(row); }
    row.marque = match.brandKey ? cap(match.brandKey) : row.marque || '';
    row.dci = match.dciFull || match.dci || row.dci || '';
    for (const k of ['utilite', 'conseil', 'posologie_defaut', 'categorie_defaut']) if (fields[k] != null) row[k] = fields[k];
    row.maj = date || new Date().toISOString().slice(0, 10);
    return row;
  }

  /* ------------------------------------------------------------------ assemblage */
  const FLAG_LABELS = {
    medicament_non_reconnu: 'Médicament non reconnu dans la BDPM : vérifier le nom',
    forme_ambigue: 'Plusieurs formes possibles pour ce nom : vérifier',
    repartition_a_preciser: 'Répartition dans la journée à préciser',
    horaire_a_confirmer: 'Horaire de prise à confirmer',
    horaires_a_verifier: 'Prises espacées en heures : horaires à vérifier',
    posologie_absente: 'Posologie absente de l’ordonnance',
    posologie_par_defaut: 'Posologie issue de la table (pas de l’ordonnance)',
    schema_complexe: 'Schéma particulier : texte libre à vérifier',
    schema_mixte: 'Schéma mixte (systématique puis si besoin) : texte libre à vérifier',
    doublon_substance: 'Même substance présente plusieurs fois dans le plan',
    lecture_incertaine: 'Nom lu avec une confiance faible : vérifier',
  };

  function buildItem(raw, idx, table) {
    const match = matchDrug(idx, raw.header, raw.body.join(' ').match(/comprim[ée]|g[ée]lule|sachet|ampoule|suppositoire|sirop|gouttes?|gel\b|cr[èe]me|pommade/i)?.[0] || '');
    const pos = parsePosology(raw.body.join(' '));
    const flags = [...pos.flags];
    if (!match.found) flags.push('medicament_non_reconnu');
    else {
      if (match.ambiguousForm) flags.push('forme_ambigue');
      if (match.confidence === 'faible') flags.push('lecture_incertaine');
    }
    const know = lookup(table, match);

    let p = pos;
    if (pos.cat === 'inconnu' && know && know.posologie_defaut) {
      p = parsePosology(know.posologie_defaut);
      p.duree = pos.duree;
      p.flags = [...p.flags];
      flags.splice(flags.indexOf('posologie_absente'), 1);
      flags.push('posologie_par_defaut');
    }
    let cat = p.cat === 'inconnu' ? (know && know.categorie_defaut) || 'quotidien' : p.cat;

    const ordo = [...p.conseils];
    if (p.duree && cat === 'quotidien') ordo.push('Pendant ' + p.duree);
    const tbl = [];
    if (know && know.conseil) {
      for (const c of know.conseil.split(/\s*[;|]\s*/)) {
        if (c && !ordo.some((x) => fold(x) === fold(c)) && !tbl.some((x) => fold(x) === fold(c))) tbl.push(c);
      }
    }

    const fmt = (v) => (v == null ? '' : showQty(v));
    return {
      source: raw.lines.join(' '),
      match, cat, flags,
      nom: match.display, dci: match.found && match.dci ? `(${match.dci})` : '',
      doses: p.doses, totalParJour: p.totalParJour,
      matin: p.doses ? fmt(p.doses.matin) : '', midi: p.doses ? fmt(p.doses.midi) : '',
      soir: p.doses ? fmt(p.doses.soir) : '', coucher: p.doses ? fmt(p.doses.coucher) : '',
      posologie: p.posologie, duree: p.duree,
      conseil: [...ordo, ...tbl].join(' ; '), conseilOrdo: ordo.join(' ; '), conseilTable: tbl.join(' ; '),
      utilite: (know && know.utilite) || '',
      connu: !!know,
    };
  }

  /* Texte OCR -> éléments structurés */
  function readPrescription(text, idx, table) {
    table = table || newTable();
    const { items, remarks } = segment(extractZone(text), idx);
    return { items: items.map((r) => buildItem(r, idx, table)), remarks };
  }

  /* Fusion de plusieurs ordonnances : repère les doublons de substance */
  function mergeReadings(readings) {
    const items = readings.flatMap((r) => r.items);
    const seen = new Map();
    for (const it of items) {
      const k = it.match.found ? it.match.dciKey : 'inconnu:' + normName(it.nom);
      if (!seen.has(k)) seen.set(k, []);
      seen.get(k).push(it);
    }
    for (const [k, g] of seen) if (g.length > 1 && !k.startsWith('inconnu:')) g.forEach((it) => it.flags.push('doublon_substance'));
    return { items, remarks: readings.flatMap((r) => r.remarks) };
  }

  /* Données pour le modèle Word (docxtemplater) */
  function planData(items, opts) {
    opts = opts || {};
    const row = (it) => ({
      nom: it.nom, dci: it.dci, matin: it.matin, midi: it.midi, soir: it.soir, coucher: it.coucher,
      posologie: it.posologie, conseil: it.conseil, utilite: it.utilite,
    });
    const pick = (c) => items.filter((i) => i.cat === c).map(row);
    return {
      date_bilan: opts.date || new Date().toLocaleDateString('fr-FR'),
      quotidien: pick('quotidien'), besoin: pick('besoin'), autre: pick('autre'),
      arretes: opts.arretes || '',
    };
  }

  return {
    createIndex, matchDrug, parseHeader, parsePosology, extractZone, segment, readPrescription, mergeReadings, planData,
    newTable, parseCsv, toCsv, lookup, remember, FLAG_LABELS, COLS, normName, fold, cleanLine,
  };
});
