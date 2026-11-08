/* Analyse pharmaceutique : recherche des interactions du Thésaurus ANSM (contre-indications et associations
 * déconseillées uniquement) entre les médicaments validés. Fonctions pures, testables sous Node. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.OrdoAnalyse = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /* Même normalisation que le script d'extraction (outils/build_thesaurus.py) */
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[’‘]/g, "'").replace(/œ/g, 'oe').replace(/[^a-z0-9()' -]/g, ' ')
    .replace(/[\s-]+/g, ' ').trim();

  const QUALIF = /\s+(hydrate|hydratee|anhydre|monohydrate|monohydratee|dihydrate|dihydratee|trihydrate|trihydratee|hemihydrate|hemihydratee|sesquihydrate|sodique|potassique|calcique|magnesienne|magnesique|base|micronise|micronisee)\b.*$/;
  const SALT = /^(chlorhydrate|dichlorhydrate|sulfate|tartrate|bitartrate|mesilate|bromhydrate|maleate|fumarate|hemifumarate|citrate|acetate|phosphate|valerate|succinate|besilate|nitrate|lactate|gluconate|tosilate|oxalate|pamoate|hyclate|lysinate|propionate|dipropionate|furoate|butyrate|bromure|chlorure|iodure)\s+(de |d')/;

  const LEVELS = {
    CI: 'Contre-indication',
    ASDEC: 'Association déconseillée',
  };
  const DEFINITIONS = {
    CI: 'Contre-indication : caractère absolu, ne doit pas être transgressée. Proposer l’arrêt de l’un des deux médicaments ou une alternative.',
    ASDEC: 'Association déconseillée : à éviter le plus souvent, sauf après examen approfondi du rapport bénéfice/risque ; impose une surveillance étroite du patient.',
    MIXTE: 'Niveau selon la situation (voir le constat) : contre-indiquée ou déconseillée dans les cas précisés par le thésaurus.',
  };

  function createBase(data) {
    const ents = data.e;
    const memberOf = new Map();
    for (const [k, [members]] of Object.entries(ents)) {
      for (const m of members) {
        const mk = norm(m);
        if (!memberOf.has(mk)) memberOf.set(mk, []);
        memberOf.get(mk).push(k);
      }
    }
    const byA = new Map();
    for (const it of data.i) {
      const [a] = it;
      if (!byA.has(a)) byA.set(a, []);
      byA.get(a).push(it);
    }
    return { ents, names: data.n || {}, alias: data.s || {}, memberOf, byA, source: data.source, version: data.version, count: data.i.length };
  }

  /* Variantes d'écriture d'un nom de substance (sels, hydrates, -ate -> acide -ique) */
  function variants(name) {
    const out = new Set();
    let s = norm(name);
    // BDPM : « Sodium (valproate de) », « Dl-lysine (acétylsalicylate de) »
    const inv = s.match(/^(.+?) \((.+?) (de|d')\)$/);
    if (inv) s = `${inv[2]} ${inv[3]} ${inv[1]}`;
    s = s.replace(/\s*\([^)]*\)\s*$/, '').trim();
    if (!s) return out;
    out.add(s);
    const q = s.replace(QUALIF, '').trim(); out.add(q);
    for (const v of [s, q]) {
      const r = v.replace(SALT, '').trim(); out.add(r);
      const r2 = r.replace(QUALIF, '').trim(); out.add(r2);
      const m = r2.match(/^([a-z]+)ate(?: (?:de|d') ?[a-z ]+)?$/);
      if (m) out.add('acide ' + m[1] + 'ique');
      const m2 = r2.match(/^([a-z]+) (?:de|d') ?(sodium|potassium|calcium|magnesium|lysine|meglumine|zinc)$/);
      if (m2) { out.add(m2[1]); const m3 = m2[1].match(/^([a-z]+)ate$/); if (m3) out.add('acide ' + m3[1] + 'ique'); }
    }
    out.delete('');
    return out;
  }

  /* Noms de substances d'une ligne du plan */
  function substancesOf(item) {
    const names = [];
    const unwrap = (t) => { t = String(t || '').trim(); return /^\(.*\)$/.test(t) ? t.slice(1, -1) : t; };
    const split = (t) => unwrap(t).split(/\s*(?:\/|\+|,|;)\s*/).map((x) => x.trim()).filter(Boolean);
    if (item.match && item.match.found) {
      names.push(...split(item.match.dciFull));
      if (item.match.subs) names.push(...item.match.subs);
    }
    names.push(...split(item.dci));
    if (!names.length || !(item.match && item.match.found)) {
      // nom saisi à la main, souvent une DCI : « Amiodarone 200 mg »
      const nom = String(item.nom || '').replace(/\d.*$/, '').trim();
      if (nom) names.push(nom);
    }
    return [...new Set(names.map(norm).filter(Boolean))];
  }

  /* Entrées du thésaurus concernées par une ligne : substance(s), classes, « voir aussi » */
  function entitiesOf(base, item) {
    const direct = new Set();
    const all = new Set();
    for (const n of substancesOf(item)) {
      for (const v of variants(n)) {
        const k = base.ents[v] ? v : base.alias[v];
        if (k) { direct.add(k); all.add(k); }
        for (const c of base.memberOf.get(v) || []) all.add(c);
      }
    }
    for (const k of [...all]) for (const sa of (base.ents[k] && base.ents[k][1]) || []) all.add(sa);
    return { direct, all };
  }

  function levelInfo(code) {
    const lv = code.split('-');
    const ci = lv.includes('CI'), asdec = lv.includes('ASDEC');
    const mixed = lv.length > 1 && !(lv.every((x) => x === lv[0]));
    if (!mixed) return { code: ci ? 'CI' : 'ASDEC', label: ci ? LEVELS.CI : LEVELS.ASDEC, rank: ci ? 0 : 1, mixed: false };
    const label = ci && asdec ? 'Contre-indication / association déconseillée (selon le cas)'
      : ci ? 'Contre-indication (selon le cas)' : 'Association déconseillée (selon le cas)';
    return { code: ci ? 'CI' : 'ASDEC', label, rank: ci ? 0.5 : 1.5, mixed: true };
  }

  /* Niveaux mixtes (« CI - PE », « ASDEC - APEC »…) : la partie grave ne s'applique parfois qu'à certaines
   * substances (« Contre-indication : - avec l'oxybate de sodium »). Dans ce cas on vérifie qu'une des
   * substances du couple y est citée ; sinon (conditions de dose, de voie…) l'alerte est conservée. */
  const SECTION = /^-?\s*(Contre-indication|Association déconseillée|Précaution d'emploi|A prendre en compte)\s*(?:avec)?\s*:?/i;
  const GRAVE = /(contre indi|deconseill)/;
  function mixedApplies(code, texte, pair) {
    const lv = code.split('-');
    if (lv.every((x) => x === 'CI' || x === 'ASDEC')) return true;
    let grave = false;
    const graveTxt = [];
    for (const ln of texte.split('\n')) {
      const m = ln.match(SECTION);
      if (m) grave = /^(contre|association)/i.test(m[1]);
      if (grave || GRAVE.test(norm(ln))) graveTxt.push(m ? ln.slice(m[0].length) : ln);
    }
    if (!graveTxt.length) return true;
    const txt = ' ' + norm(graveTxt.join(' ')) + ' ';
    // la partie grave ne vise que certaines substances : l'une d'elles doit être dans le couple
    if (!/ (avec|pour|entre) (l'|le |la |les |du |des )/.test(txt)) return true;
    for (const P of pair) for (const n of P.names) if (n.length >= 4 && txt.includes(n)) return true;
    return false;
  }

  /* Recherche des interactions entre les lignes fournies (lignes validées) */
  function analyse(base, items) {
    const info = items.map((it) => {
      const e = entitiesOf(base, it);
      const names = new Set();
      for (const n of substancesOf(it)) for (const v of variants(n)) names.add(v);
      for (const k of e.direct) names.add(k);
      return { it, ...e, names };
    });
    const found = [];
    const seen = new Set();
    for (let x = 0; x < info.length; x++) {
      for (let y = x + 1; y < info.length; y++) {
        const X = info[x], Y = info[y];
        if (!X.all.size || !Y.all.size) continue;
        const sameSubs = X.direct.size && [...X.direct].every((k) => Y.direct.has(k)) && X.direct.size === Y.direct.size;
        for (const [P, Q] of [[X, Y], [Y, X]]) {
          for (const e of P.all) {
            for (const r of base.byA.get(e) || []) {
              const [a, b, code, texte, A, B] = r;
              let ok = Q.all.has(b);
              if (!ok && !sameSubs) {
                const cls = b.startsWith('autres ') ? b.slice(7) : b.endsWith(' (autres)') ? b.slice(0, -9) : null;
                if (cls && P.all.has(cls) && Q.all.has(cls)) ok = true;
              }
              if (!ok) continue;
              const pairKey = [X.it.id, Y.it.id].sort().join('|') + '#' + [a, b.replace(/^autres /, '')].sort().join('|');
              if (seen.has(pairKey)) continue;
              seen.add(pairKey);
              const lv = levelInfo(code);
              if (lv.mixed && !mixedApplies(code, texte, [X, Y])) continue;
              found.push({
                id: pairKey, itemA: P.it, itemB: Q.it, entA: A, entB: B,
                niveau: lv.label, code: lv.code, mixte: lv.mixed, rank: lv.rank, texte,
              });
            }
          }
        }
      }
    }
    // Par couple de médicaments : on garde l'alerte la plus grave, et les autres de même gravité
    found.sort((u, v) => u.rank - v.rank);
    const best = new Map();
    return found.filter((f) => {
      const k = [f.itemA.id, f.itemB.id].sort().join('|');
      if (!best.has(k)) { best.set(k, f.rank); return true; }
      return f.rank <= best.get(k) && !f.mixte;
    });
  }

  const label = (it) => [it.nom, it.dci].filter(Boolean).join(' ').trim();

  /* Ligne du tableau « Points d'attention pharmaceutiques » (page 2 du modèle Word) */
  function reportRow(f) {
    const ent = (n) => n.charAt(0) + n.slice(1).toLowerCase();
    return {
      medicament: `${label(f.itemA)}\n+ ${label(f.itemB)}`,
      type: `Interaction – ${f.niveau.charAt(0).toLowerCase() + f.niveau.slice(1)}`,
      constat: `${ent(f.entA)} + ${ent(f.entB)} : ${f.texte}\n(Thésaurus ANSM, sept. 2023)`,
      proposition: f.mixte ? DEFINITIONS.MIXTE : DEFINITIONS[f.code],
    };
  }

  return { norm, variants, substancesOf, entitiesOf, createBase, analyse, reportRow, levelInfo, DEFINITIONS };
});
