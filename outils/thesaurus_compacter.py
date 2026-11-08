#!/usr/bin/env python3
"""Étape 2/2 : compacte le JSON brut en data/thesaurus_interactions.json pour le téléphone (clés normalisées, alias, voir aussi)."""
import json, re, sys
d = json.load(open(sys.argv[1], encoding="utf-8"))
E, I = d["entities"], d["interactions"]
keys = set(E)

def sp(s):  # compare ignoring hyphens/spaces
    return re.sub(r"[\s-]+", " ", s).strip()

spk = {sp(k): k for k in keys}
def resolve(name):
    name = re.sub(r"\s*-\s*$", "", name).strip()
    if name in keys: return name
    if sp(name) in spk: return spk[sp(name)]
    c = [k for k in keys if sp(k).startswith(sp(name))]
    return c[0] if len(c) == 1 else None

ents = {}
for k, v in E.items():
    sa = [r for r in (resolve(s) for s in v["v"]) if r and r != k]
    ents[k] = [v["m"], sorted(set(sa))]

# aliases for substance entities
alias = {}
def add(a, k):
    a = sp(a)
    if a and a not in keys and a not in alias: alias[a] = k
for k, (m, _) in ents.items():
    x = re.match(r"^(.*?) \((et par extrapolation )?(.*?)\)$", k)
    if x:
        base, ext, inner = x.group(1), x.group(2), x.group(3)
        if not inner.endswith((" de", " d'")): add(base, k)
        if ext: add(inner, k)
        elif inner in ("sels", "toxine", "acide") or inner.endswith((" de", " d'")): add(inner + " " + base, k)
    y = re.match(r"^(.*?) \((acide)\) et par extrapolation (.*)$", k)
    if y:
        add("acide " + y.group(1), k); add(y.group(3), k)

def clean(t):
    out = ""
    for ln in t.split("\n"):
        ln = ln.strip()
        if not ln: continue
        brk = ln.startswith("- ") or re.match(r"^(Contre-indication|Association déconseillée|Précaution d'emploi|A prendre en compte)\b", ln) \
            or (out.endswith(":"))
        out += ("\n" if brk and out else (" " if out else "")) + ln
    return out.replace("’", "'").replace("‘", "'")

LV = {"CI": 0, "ASDEC": 1, "PE": 2, "APEC": 3}
inter = []
for x in I:
    lv = sorted(set(x["l"]), key=LV.get)
    inter.append([x["a"], x["b"], "-".join(lv), clean(x["t"]), x["A"], x["B"]])
names = {sp(k): E[k]["n"] for k in E}
ents = {sp(k): [[sp(m) for m in v[0]], [sp(s) for s in v[1]]] for k, v in ents.items()}
alias = {sp(a): sp(k) for a, k in alias.items()}
inter = [[sp(a), sp(b)] + rest for a, b, *rest in inter]
out = {"source": "ANSM – Thésaurus des interactions médicamenteuses (septembre 2023)",
       "version": "2023-09", "niveaux": "CI et ASDEC uniquement",
       "e": ents, "n": names, "s": alias, "i": inter}
json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
print(len(ents), "entités", len(alias), "alias", len(inter), "interactions", file=sys.stderr)
print(sorted(alias.items())[:80], file=sys.stderr)
