"""Manual real-provider probes, never invoked by pnpm test. See FINDINGS.md."""
from common import *
require_real()
import sys, runpy, hashlib
cmd=sys.argv[1]
if cmd=='env-baseline':
    existing=set(tmux('list-windows','-t','s06','-F','#{window_name}').splitlines())
    for variant,envargs in [('bare',['-e','CLAUDE_CODE_S06','-e','HERDR_S06']),('empty',['-e','CLAUDE_CODE_S06=','-e','HERDR_S06='])]:
        if 'env-'+variant in existing:raise SystemExit('Baseline pane already exists')
        tmux('new-window','-d','-t','s06:','-n','env-'+variant,'-c',str(ROOT/'repo'),*envargs,'python3',str(ROOT/'repo'/'env-probe.py'))
        time.sleep(.2)
        print(variant,tmux('capture-pane','-p','-t','s06:env-'+variant,'-S','-100'))
elif cmd=='trust-claude':
    tmux('send-keys','-t','s06:claude','Down','Enter')
    time.sleep(3)
    print(tmux('capture-pane','-p','-t','s06:claude'))
elif cmd=='status':
    print('panes',tmux('list-panes','-a','-F','#{pane_id}|#{window_name}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}|#{pane_dead}|#{pane_dead_status}'))
    print('provider',provider())
    print('hooks',[(r['body'].get('hook_event_name'),r['body'].get('source')) for r in hooks()[-8:]])
    if len(sys.argv)>2: print(tmux('capture-pane','-p','-t','s06:'+sys.argv[2],'-S','-40'))
elif cmd=='send':
    t=send(sys.argv[2]); r=wait_hook('Stop',t)
    print(json.dumps({'sendMs':t,'submitted':len(hooks('UserPromptSubmit',t)),'stop':r['body'].get('last_assistant_message') if r else None}))
elif cmd=='keys':
    if 'keys' in tmux('list-windows','-t','s06','-F','#{window_name}').splitlines():raise SystemExit('Owned key logger already exists')
    print(tmux('new-window','-d','-P','-F','#{pane_id}','-t','s06:','-n','keys','-c',str(ROOT/'repo'),'-e',f'KEYLOG={ROOT}/keylog.txt','python3',str(HERE/'keylog.py'),'--paste','--mouse','--kitty'))
elif cmd=='bulk':
    fixtures=runpy.run_path(str(HERE.parent/'02-claude-hooks'/'prompts.py'))['build']()
    first=int(sys.argv[2]) if len(sys.argv)>2 else 0
    last=int(sys.argv[3]) if len(sys.argv)>3 else 99
    for p in fixtures[first:last+1]:
        t=send(p['text'])
        if p['cat'] in {'slash-word','bang'}:
            time.sleep(3)
        else:
            stop=wait_hook('Stop',t,60)
            if stop is None:
                print('stop timeout',p['id'],flush=True)
                break
        ups=hooks('UserPromptSubmit',t)
        marker=p['id'].lower()
        matches=[r for r in ups if marker in r['body'].get('prompt','').lower()]
        row={'id':p['id'],'category':p['cat'],'sendMs':t,'submitCount':len(matches),'exactCount':sum(r['body'].get('prompt')==p['text'] for r in matches),'latencyMs':round(matches[0]['recv_ms']-t,1) if matches else None,'sha256':hashlib.sha256(p['text'].encode()).hexdigest(),'received':matches[0]['body'].get('prompt') if matches and p['cat']=='special' and matches[0]['body'].get('prompt')!=p['text'] else None}
        with open(ROOT/'bulk.jsonl','a') as f:f.write(json.dumps(row)+'\n')
        print(json.dumps(row),flush=True)
        time.sleep(.25)
elif cmd=='environment':
    for v in ['bare','empty']:
        print(v,tmux('capture-pane','-p','-t','s06:env-'+v,'-S','-100'))
    t=send('Run python3 env-probe.py. Report only its JSON output; do not read any other environment values.')
    r=wait_hook('Stop',t)
    if r: print(r['body'].get('last_assistant_message'))
    else: print('No Stop; inspect permission hook',hooks('PermissionRequest',t))
else: raise SystemExit('Unknown probe')
