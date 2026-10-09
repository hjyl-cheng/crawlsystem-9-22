"""Derive new-system query bindings from the legacy crawlSystem exports (plan step B2, 2026-10-09).

Inputs (CSV with header, produced read-only on the legacy server, see export-*.sql):
  terms.csv       searched legacy terms with their page counts (export-searched-terms.sql)
  categories.csv  per term, profiled channels it found by Agent level-1 category (export-term-categories.sql)
  yield.csv       per term, new candidate channels it found (export-term-yield.sql)
Rule: a term is bound to every business category holding at least 40% (and at least 2) of the profiled
channels it found, at most two, else to the top category if it has at least 2; terms without one are left
out. Country BR, language pt (every legacy search ran pt/BR). Priority = new candidate channels found.

  python3 derive-query-bindings.py <dir with the three CSVs> > bindings.json
"""
import collections, csv, json, sys

CATEGORIES = ['Automotive', 'Beauty Creators', 'Casual Vlogs', 'Dance', 'Education', 'Fashion', 'Food', 'Gaming', 'General Humanities & Society',
              'Health & Wellness', 'Home', 'Music', 'Parenting', 'Pets & Animals', 'Self Improvement', 'Software & Internet', 'Sports & Outdoors', 'Tech', 'Travel']
root = sys.argv[1]
def rows(name):
    with open(f'{root}/{name}', newline='') as f:
        reader = csv.reader(f); next(reader); yield from reader
terms = {r[0]: r[1] for r in rows('terms.csv')}
found = collections.defaultdict(collections.Counter)
for qid, level_1, channels in rows('categories.csv'):
    if level_1 in CATEGORIES: found[qid][level_1] += int(channels)
new_candidates = {r[0]: int(r[1]) for r in rows('yield.csv')}
out = []
for qid, text in terms.items():
    counts = found.get(qid)
    if not counts: continue
    total = sum(counts.values())
    chosen = [c for c, n in counts.most_common() if n >= 2 and n / total >= 0.4][:2]
    if not chosen and counts.most_common(1)[0][1] >= 2: chosen = [counts.most_common(1)[0][0]]
    for category in chosen:
        out.append({'text': text, 'country': 'BR', 'language': 'pt', 'category': category, 'priority': new_candidates.get(qid, 0),
                    'source_type': 'AUTO_TAG', 'source_ref': f'legacy:crawlsystem:query_terms:{qid}'})
json.dump(out, sys.stdout, ensure_ascii=False)
