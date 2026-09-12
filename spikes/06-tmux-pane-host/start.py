"""Start only the already-created spike fixture services; never an existing server."""
from setup import *
ROOT.joinpath('owned-pids.json').is_file() or exit('Run setup first')
env=clean_env(); env.update(S06_SERVER_SENTINEL='server-only', CLAUDE_CODE_S06='fake', HERDR_S06='fake')
r=subprocess.run(TMUX+['list-sessions'],capture_output=True)
if r.returncode==0: raise SystemExit('Server already running; refusing to start')
subprocess.run(TMUX+['-f',str(ROOT/'tmux.conf'),'new-session','-d','-s','s06','-n','anchor','-c',str(ROOT/'repo'),'/bin/cat'],env=env,check=True)
subprocess.run(TMUX+['list-sessions'],check=True)
owned=json.loads((ROOT/'owned-pids.json').read_text())
for name,args in [('hooks',['node',str(HERE/'hook-server.mjs'),'47806',str(ROOT/'hooks.jsonl')]),('codex-server',['codex','app-server','--listen',f'unix://{ROOT}/codex.sock'])]:
    try:
        if name in owned:
            os.kill(owned[name],0); print(name,'already alive'); continue
    except ProcessLookupError: pass
    with open(ROOT/'logs'/f'{name}.log','ab') as log:
        p=subprocess.Popen(args,cwd=ROOT/'repo',env={**clean_env(),'CODEX_HOME':str(ROOT/'home')},stdout=log,stderr=log,start_new_session=True)
    owned[name]=p.pid
(ROOT/'owned-pids.json').write_text(json.dumps(owned)); print(json.dumps(owned))
