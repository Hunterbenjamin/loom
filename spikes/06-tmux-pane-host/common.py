"""Utilities restricted to the spike's one server, repo and recorded providers."""
from setup import HERE, ROOT, TMUX, clean_env
import json, os, pathlib, subprocess, time

def tmux(*args, check=True):
    r=subprocess.run(TMUX+list(args),capture_output=True,text=True,env=clean_env())
    if check and r.returncode: raise RuntimeError(r.stderr.strip())
    return r.stdout.strip()

def hooks(event=None, since=0):
    path=ROOT/'hooks.jsonl'
    if not path.exists(): return []
    result=[]
    for line in path.read_text().splitlines():
        try: row=json.loads(line)
        except json.JSONDecodeError: continue
        b=row.get('body',{})
        if b.get('session_id')!=sid() or row['recv_ms']<since: continue
        if event is None or b.get('hook_event_name')==event: result.append(row)
    return result

def sid(): return (ROOT/'claude-session-id').read_text().strip()

def wait_hook(event,since,timeout=40):
    end=time.monotonic()+timeout
    while time.monotonic()<end:
        hs=hooks(event,since)
        if hs: return hs[-1]
        time.sleep(.1)
    return None

def validated(kind,raw):
    r=subprocess.run(['node',str(HERE/'validate.mjs'),kind],input=raw,capture_output=True,text=True,check=True)
    return json.loads(r.stdout)

def provider():
    # Only return our provider entry, never print/read anyone else's transcript.
    r=subprocess.run(['claude','agents','--json'],capture_output=True,text=True,env=clean_env(),check=True)
    rows=validated('agents',r.stdout)
    return next((r for r in rows if r.get('sessionId')==sid()),None)

def send(text,target='s06:claude',settle=.15):
    if target not in {'s06:claude','s06:codex','s06:keys'}: raise ValueError('Unowned target')
    started=time.time()*1000
    # tmux's CLI message limit rejects a 20 KB argv. Append bounded chunks.
    chunks=[text[i:i+4096] for i in range(0,len(text),4096)] or ['']
    for i,chunk in enumerate(chunks):
        tmux('set-buffer',*(['-a'] if i else []),'-b','s06-prompt','--',chunk)
    tmux('paste-buffer','-p','-d','-b','s06-prompt','-t',target)
    time.sleep(settle)
    tmux('send-keys','-t',target,'Enter')
    return started

def launch(provider_name,resume=False):
    require_real()
    if provider_name in tmux('list-windows','-t','s06','-F','#{window_name}').splitlines():
        raise RuntimeError('Refusing duplicate provider window')
    args=['new-window','-d','-P','-F','#{pane_id}','-t','s06:','-n',provider_name,'-c',str(ROOT/'repo')]
    # NAME with no '=' is tested separately. Real provider launches additionally remove
    # all unwanted server variables at session scope before they can enter a child.
    args += ['-e','S06_LAUNCH=owned']
    if provider_name=='claude':
        command=['claude','--resume' if resume else '--session-id',sid(),'--settings',str(ROOT/'settings.json'),'--model','haiku']
    elif provider_name=='codex':
        args += ['-e',f'CODEX_HOME={ROOT}/home']
        command=['codex','resume',(ROOT/'codex-thread-id').read_text().strip(),'--remote',f'unix://{ROOT}/codex.sock','-c','model="gpt-5.6-luna"']
    else: raise ValueError('Unowned provider')
    return tmux(*args,*command)


def require_real():
    if os.environ.get("LOOM_REAL_PROVIDERS")!="1":
        raise SystemExit("Manual real-provider probe: set LOOM_REAL_PROVIDERS=1")
