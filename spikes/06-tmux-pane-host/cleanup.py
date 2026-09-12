"""Stop only the named test host and recorded, argv-guarded private service groups."""
from lifecycle import *
import signal
row={'time':time.time(),'services':{}}
panes=pane_facts()
if native() and native()['status']!='idle':raise SystemExit('Claude still active; inspect before cleanup')
if rpc('read')['status']['type']!='idle':raise SystemExit('Codex still active; inspect before cleanup')
send('/exit');time.sleep(.5)
tmux('send-keys','-t','s06:codex','C-c');time.sleep(.3);tmux('send-keys','-t','s06:codex','C-c')
tmux('kill-server');time.sleep(.3)
for n in range(50):
    if not any(alive(r['pid']) for r in panes):break
    time.sleep(.1)
row['paneProcessesAlive']={r['window']:alive(r['pid']) for r in panes}
for name,pid in json.loads((ROOT/'owned-pids.json').read_text()).items():
    if not alive(pid):row['services'][name]='already exited';continue
    argv=subprocess.check_output(['ps','-p',str(pid),'-o','command='],text=True)
    expected=str(HERE/'hook-server.mjs') if name=='hooks' else 'app-server --listen unix://'+str(ROOT/'codex.sock')
    if expected not in argv or os.getpgid(pid)!=pid:raise SystemExit('Refusing unrecognized service process group: '+name)
    os.killpg(pid,signal.SIGTERM)
    for n in range(50):
        if not alive(pid):break
        time.sleep(.1)
    row['services'][name]={'alive':alive(pid)}
row['tmuxServerPresent']=bool(tmux('list-sessions',check=False))
row['codexSocketExists']=(ROOT/'codex.sock').exists()
row['ghosttyWindow']='Visual inspection was blocked; the owned test window may remain showing an exited command. No tmux client remains.'
save('cleanup',row)
