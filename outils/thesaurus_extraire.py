#!/usr/bin/env python3
"""Étape 1/2 : extrait le Thésaurus ANSM des interactions (texte issu du PDF, ex. pdftotext) en JSON brut.

Usage : python thesaurus_extraire.py thesaurus.txt interactions_brut.json
Puis : python thesaurus_compacter.py interactions_brut.json ../data/thesaurus_interactions.json
Ne conserve que les contre-indications et associations déconseillées (y compris niveaux mixtes).
"""
import re, json, sys, unicodedata

src, out = sys.argv[1], sys.argv[2]
raw = [l.rstrip("\n").rstrip(" \t\r\f") for l in open(src, encoding="utf-8", errors="replace")]
# drop blank lines and page numbers
lines = [l for l in raw if l and not re.fullmatch(r"\d{1,3}", l)]

LEVELS = {"CONTRE-INDICATION": "CI", "Association DECONSEILLEE": "ASDEC",
          "Précaution d'emploi": "PE", "A prendre en compte": "APEC"}
LEVEL_RE = re.compile(r"(?:^|\s)(CONTRE-INDICATION|Association DECONSEILLEE|Précaution d'emploi|A prendre en compte)$")
MIXED_RE = re.compile(r"^(CI|ASDEC|PE|APEC)( - (CI|ASDEC|PE|APEC))+$")

def norm(s):
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    s = s.lower().replace("’", "'").replace("œ", "oe")
    s = re.sub(r"[^a-z0-9()' -]", " ", s)
    return re.sub(r"\s+", " ", s).strip()

def caps(l):
    if not l or l[0] in "+(-" or MIXED_RE.match(l) or l in LEVELS or l.startswith("CONTRE-INDICATION"):
        return False
    letters = [c for c in l if c.isalpha()]
    return len(letters) >= 3 and all(c.isupper() for c in letters)

def starts_block(l):
    return l.startswith(("(", "Voir aussi", "+ ")) or len(l) > 120

def is_header(i):
    if not caps(lines[i]):
        return False
    n1 = lines[i+1] if i + 1 < len(lines) else ""
    if starts_block(n1):
        return True
    if not (caps(n1) or len(n1) > 90):
        return False
    for j in range(i + 1, min(i + 14, len(lines))):
        if lines[j].startswith(("(", "Voir aussi", "+ ")):
            return True
    return False

def header_wrap(i):
    """True when lines[i] is the 2nd line of a wrapped header."""
    return False

start = lines.index("ABATACEPT")
entities, inters = {}, []
cur = it = None
state = None  # 'pre' (after header) | 'it' (inside an interaction)

def close_it():
    global it
    if it:
        it["text"] = "\n".join(it.pop("lines")).strip()
        inters.append(it)
    it = None

i = start
while i < len(lines):
    l = lines[i]
    if l.startswith("+ "):
        close_it()
        tgt = l[2:].strip()
        while i + 1 < len(lines) and caps(lines[i+1]) and not is_header(i+1) and not lines[i+1].startswith(("CI", "ASDEC")) and len(tgt) > 40:
            i += 1; tgt += " " + lines[i].strip()
        it = {"a": cur["name"], "b": tgt, "levels": [], "lines": []}
        state = "it"; i += 1; continue
    if is_header(i):
        close_it()
        name = l.strip()
        if i + 2 < len(lines) and caps(lines[i+1]) and lines[i+2].startswith(("(", "Voir aussi", "+ ")) and (name.endswith((" ET", ",", " DE", " DU", " DES", " À", " LES", " PAR")) ):
            i += 1; name += " " + lines[i].strip()
        cur = {"name": name, "members": [], "see_also": []}
        entities.setdefault(norm(cur["name"]), cur)
        cur = entities[norm(cur["name"])]
        state = "pre"; i += 1; continue
    if state == "pre":
        if l.startswith("(") and not cur["members"]:
            buf = l
            while not buf.rstrip().endswith(")") and i + 1 < len(lines) and not lines[i+1].startswith(("+ ", "Voir aussi", "(")) and not is_header(i+1):
                i += 1; buf += " " + lines[i]
            body = buf[1:-1] if buf.endswith(")") else buf[1:]
            cur["members"] = [m.strip() for m in body.split(",") if m.strip()]
        elif l.startswith("Voir aussi"):
            buf = l.split(":", 1)[1]
            while i + 1 < len(lines) and not lines[i+1].startswith(("+ ", "Voir aussi", "(")) and not is_header(i+1) and len(lines[i+1]) < 200 and not re.match(r"^[A-Z][a-z]", lines[i+1]):
                i += 1; buf += " " + lines[i]
            cur["see_also"] += [s.strip() for s in re.split(r"\s-\s", buf) if s.strip()]
        i += 1; continue
    if state == "it":
        mm = re.search(r"(?:^|\s)((?:CI|ASDEC|PE|APEC)(?: - (?:CI|ASDEC|PE|APEC))+)$", l)
        if mm:
            it["levels"] = mm.group(1).split(" - "); it["mixed"] = True
            l = l[:mm.start()].strip()
            if l: it["lines"].append(l)
        else:
            m = LEVEL_RE.search(l)
            if m:
                if not it.get("mixed"):
                    it["levels"].append(LEVELS[m.group(1)])
                l = l[:m.start()].strip()
            if l:
                it["lines"].append(l)
    i += 1
close_it()

keep = [x for x in inters if any(v in ("CI", "ASDEC") for v in x["levels"])]
print("entities", len(entities), "interactions", len(inters), "kept", len(keep), file=sys.stderr)
print("no level:", [(x["a"], x["b"]) for x in inters if not x["levels"]][:20], file=sys.stderr)

ents = {k: {"n": v["name"], "m": sorted(set(norm(m) for m in v["members"])), "v": [norm(s) for s in v["see_also"]]}
        for k, v in entities.items()}
data = {"source": "ANSM – Thésaurus des interactions médicamenteuses, septembre 2023",
        "entities": ents,
        "interactions": [{"a": norm(x["a"]), "b": norm(x["b"]), "A": x["a"], "B": x["b"],
                          "l": x["levels"], "t": x["text"]} for x in keep]}
json.dump(data, open(out, "w", encoding="utf-8"), ensure_ascii=False, separators=(",", ":"))
tg = set(norm(x["b"]) for x in keep)
miss = sorted(t for t in tg if t not in entities and not (t.startswith("autres ") and t[7:] in entities))
print("unmatched targets", len(miss), miss, file=sys.stderr)
sa = set(s for v in ents.values() for s in v["v"])
print("unmatched see-also", sorted(s for s in sa if s not in ents), file=sys.stderr)
