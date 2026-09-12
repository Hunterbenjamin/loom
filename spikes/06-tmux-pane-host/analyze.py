"""Independent whole-session delivery readback, with hashes instead of prompt contents."""
from common import *
import hashlib,runpy,statistics
fixtures=runpy.run_path(str(HERE.parent/'02-claude-hooks'/'prompts.py'))['build']()
rows=[json.loads(l) for l in (ROOT/'bulk.jsonl').read_text().splitlines()]
assert len(rows)==100 and len({r['id'] for r in rows})==100
hs=validated('hooks',json.dumps([json.loads(l) for l in (ROOT/'hooks.jsonl').read_text().splitlines()]))
ups=[r for r in hs if r['body']['session_id']==sid() and r['body']['hook_event_name']=='UserPromptSubmit']
checks=[]
for p in fixtures:
    # [Pnnn], /pnnn or pnnn-bang are unique fixture markers; count across the whole session.
    found=[r for r in ups if p['id'].lower() in r['body'].get('prompt','').lower()]
    exact=[r for r in found if r['body']['prompt']==p['text']]
    checks.append({'id':p['id'],'category':p['cat'],'count':len(found),'exact':len(exact),'receivedHashes':[hashlib.sha256(r['body']['prompt'].encode()).hexdigest() for r in found]})
summary={'attemptedFixtures':100,'transportPreSendFailures':{'P055':'single argv set-buffer: command too long; resent once using bounded append chunks, no first delivery'},'totalSubmits':sum(x['count'] for x in checks),'exactlyOnce':sum(x['count']==1 for x in checks),'byteIdenticalExactlyOnce':sum(x['count']==1 and x['exact']==1 for x in checks),'duplicates':[x['id'] for x in checks if x['count']>1],'categories':{},'wholeSessionChecks':checks}
for c in sorted({p['cat'] for p in fixtures}):
    rs=[r for r in rows if r['category']==c];cs=[r for r in checks if r['category']==c];ts=sorted(r['latencyMs'] for r in rs if r['latencyMs'] is not None)
    summary['categories'][c]={'sent':len(rs),'exactlyOnce':sum(r['count']==1 for r in cs),'byteIdentical':sum(r['count']==1 and r['exact']==1 for r in cs),'medianMs':statistics.median(ts) if ts else None,'p95Ms':ts[int(.95*len(ts))] if ts else None}
plain=sorted(r['latencyMs'] for r in rows if r['latencyMs'] is not None and r['category']!='20kb')
summary['under5kb']={'n':len(plain),'medianMs':statistics.median(plain),'p95Ms':plain[int(.95*len(plain))]}
(ROOT/'bulk-summary.json').write_text(json.dumps(summary,indent=2))
print(json.dumps({k:v for k,v in summary.items() if k!='wholeSessionChecks'},indent=2))
