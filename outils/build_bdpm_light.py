#!/usr/bin/env python3
"""Construit bdpm_light.json (index léger pour le téléphone) à partir des fichiers BDPM.

Usage : python build_bdpm_light.py CIS_bdpm.txt CIS_COMPO_bdpm.txt [bdpm_light.json]
Fichiers à télécharger sur https://base-donnees-publique.medicaments.gouv.fr (rubrique Téléchargement).
Ne conserve que les spécialités commercialisées, avec AMM active : nom, forme, voie, substances actives.
"""
import json, sys, datetime

def lire(chemin):
    with open(chemin, 'rb') as f:
        brut = f.read()
    try:
        txt = brut.decode('utf-8')
    except UnicodeDecodeError:
        txt = brut.decode('cp1252')
    return [l.split('\t') for l in txt.splitlines() if l.strip()]

def main(cis_path, compo_path, out='bdpm_light.json'):
    subs = {}
    for r in lire(compo_path):
        if len(r) < 7 or r[6].strip() != 'SA':
            continue
        nom = r[3].strip()
        lst = subs.setdefault(r[0], [])
        if nom and all(nom != s[0] for s in lst):
            lst.append([nom, r[4].strip()])
    prod = []
    for r in lire(cis_path):
        if len(r) < 7 or r[6].strip() != 'Commercialisée' or r[4].strip() != 'Autorisation active':
            continue
        prod.append([r[0], r[1].strip(), r[2].strip(), r[3].strip(), subs.get(r[0], [])])
    data = {'version': datetime.date.today().isoformat(), 'p': prod}
    with open(out, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, separators=(',', ':'))
    print(f'{len(prod)} spécialités -> {out}')

if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(*sys.argv[1:4])
