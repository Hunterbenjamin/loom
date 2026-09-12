"""Export only a fixed list of experiment summaries; never copy auth or raw transcripts."""
from common import *
import shutil
out=ROOT/'exported-evidence';out.mkdir(exist_ok=True)

def scrub(value):
    if isinstance(value,dict):return {k:scrub(v) for k,v in value.items()}
    if isinstance(value,list):return [scrub(v) for v in value]
    if isinstance(value,str):
        return value.replace(str(ROOT.resolve()),'$SPIKE').replace(str(ROOT),'$SPIKE').replace(str(HERE),'$HARNESS')
    return value

def write(name,data):
    (out/name).write_text(json.dumps(scrub(data),indent=2)+'\n')

for name in ['bulk-summary','electron-latency','electron-keys-default','electron-keys','electron-ghostty','electron-scroll','working','blocked','interrupt-claude','interrupt-codex','exit','restart-1-partial','restart-2','restart-3','restart-4','discovery','cleanup']:
    source=ROOT/(name+'.json')
    if source.exists():write(name+'.json',json.loads(source.read_text()))
events=[json.loads(l) for l in (ROOT/'rpc-events.jsonl').read_text().splitlines()]
if (ROOT/'restart-1-partial.json').exists():
    partial=json.loads((ROOT/'restart-1-partial.json').read_text())
    partial['nativeTurnCompletedEvents']=[e for e in events if e.get('method')=='turn/completed' and e.get('turn',{}).get('id')==partial['codexMidTurnId']]
    write('restart-1-partial.json',partial)
# Preserve the fixture receipts and original send-time observations as well as independent recounts.
(out/'bulk.jsonl').write_text('\n'.join(json.dumps(scrub(json.loads(l))) for l in (ROOT/'bulk.jsonl').read_text().splitlines())+'\n')
hs=hooks()
envs=[r['body']['tool_response'] for r in hs if r['body'].get('hook_event_name')=='PostToolUse' and 'env-probe.py' in json.dumps(r['body'].get('tool_input',{}))]
if envs:
    d=json.loads(envs[0]['stdout'])
    write('environment.json',{'insideClaudeTool':d,'inheritedMarkerNamesPresent':[k for k in d['keys'] if k in ['CLAUDE_CODE_S06','HERDR_S06','S06_SERVER_SENTINEL']],'removedServerVariables':len(json.loads((ROOT/'environment-removals.json').read_text())),'baseline':'Both -e NAME and -e NAME= retained the two fake marker names; S06_SERVER_SENTINEL=server-only reached both children. See command and captured output in FINDINGS.md.'})
shift=json.loads((ROOT/'electron-shift-agents.json').read_text())
write('shift-agents.json',{target:{'startMs':r['startMs'],'sent':[x for x in r['sent'] if '[<35;' not in x],'promptTail':[line for line in r['screen'].splitlines() if line.strip()][-7:],'newClaudePromptsDuringProbe':len([h for h in hs if h['body'].get('hook_event_name')=='UserPromptSubmit' and r['startMs']<=h['recv_ms']<=r['startMs']+2000]) if 'claude' in target else None} for target,r in shift['agents'].items()})
if (ROOT/'two-clients.png').exists():shutil.copyfile(ROOT/'two-clients.png',out/'electron-two-clients.png')
print('Exported sanitized experiment evidence:',out)
