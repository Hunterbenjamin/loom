"""Bounded state probes against our stored Claude ID and private Codex socket."""
from common import *
import sys, threading

def save(name,row):
    (ROOT/f'{name}.json').write_text(json.dumps(row,indent=2));print(json.dumps(row),flush=True)

def native():
    p=provider()
    return {k:p.get(k) for k in ['sessionId','pid','cwd','status']} if p else None

def rpc(action,*args):
    p=subprocess.run(['node',str(HERE/'rpc.mjs'),action,*args],capture_output=True,text=True,check=True,env=clean_env())
    return json.loads(p.stdout.strip().splitlines()[-1])

def alive(pid):
    try: os.kill(int(pid),0); return True
    except ProcessLookupError:return False

def control():
    p=subprocess.Popen(TMUX+['-C','attach','-t','s06','-f','no-output,ignore-size'],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.PIPE,text=True,env=clean_env())
    events=[]
    def read():
        for line in p.stdout:
            if not line.startswith(('%output','%extended-output')):events.append({'ms':time.time()*1000,'line':line.strip()})
    threading.Thread(target=read,daemon=True).start()
    return p,events

def pane_facts():
    rows=[]
    for line in tmux('list-panes','-a','-F','#{pane_id}|#{window_name}|#{pane_pid}|#{pane_current_command}|#{pane_current_path}|#{pane_start_path}|#{pane_dead}|#{pane_dead_status}').splitlines():
        p,name,pid,command,cwd,start,dead,status=line.split('|')
        rows.append({'pane':p,'window':name,'pid':int(pid),'command':command,'cwd':cwd,'startPath':start,'dead':dead=='1','exitStatus':status})
    return validated('panes',json.dumps(rows))

def main():
    require_real()
    cmd=sys.argv[1]
    if cmd=='working':
        t=send('Use Bash to run exactly python3 hold.py, then reply S06_WORK_DONE.')
        pre=wait_hook('PreToolUse',t,30)
        if pre is None:raise SystemExit('No tool start')
        time.sleep(2)
        before=native()
        if before['status']!='busy':raise SystemExit('Not mid-turn')
        q=send('S06_WHILE_WORKING Reply with S06_QUEUED after the tool completes.')
        up=wait_hook('UserPromptSubmit',q,10)
        stop=wait_hook('Stop',t,50)
        save('working',{'before':before,'firstPromptId':hooks('UserPromptSubmit',t)[0]['body'].get('prompt_id'),'secondPromptId':up['body'].get('prompt_id') if up else None,'secondDeliveryMs':up['recv_ms']-q if up else None,'stops':len(hooks('Stop',t)),'reply':stop['body'].get('last_assistant_message') if stop else None})
    elif cmd=='blocked':
        target=ROOT/'repo'/'s06-permission.txt'
        if target.exists():raise SystemExit('Fixture already exists; choose a new owned fixture')
        t=send('Use Bash to run exactly touch s06-permission.txt. Do not use other tools. Then reply S06_PERMISSION_DONE.')
        permission=wait_hook('PermissionRequest',t,25)
        if not permission: save('blocked',{'notRun':'No permission dialog','provider':native()});raise SystemExit(1)
        before=native();q=send('S06_WHILE_BLOCKED Reply exactly S06_BLOCKED_ACK.')
        time.sleep(3)
        save('blocked',{'permissionTool':permission['body'].get('tool_name'),'before':before,'after':native(),'promptSubmits':len(hooks('UserPromptSubmit',q)),'postToolUses':len(hooks('PostToolUse',q)),'fileExists':target.exists(),'events':[r['body'].get('hook_event_name') for r in hooks(since=q)]})
    elif cmd=='interrupt-claude':
        t=send('Use Bash to run exactly python3 hold.py, then reply S06_INTERRUPT_UNEXPECTED.')
        pre=wait_hook('PreToolUse',t,30)
        if not pre:raise SystemExit('No tool start')
        time.sleep(2);before=native()
        if before['status']!='busy':raise SystemExit('Not working')
        q=time.time()*1000;tmux('send-keys','-t','s06:claude','Escape')
        after=None
        for n in range(100):
            after=native()
            if after and after['status']=='idle':break
            time.sleep(.1)
        elapsed=time.time()*1000-q
        time.sleep(1)
        transcript=pathlib.Path(pre['body']['transcript_path'])
        records=[json.loads(line) for line in transcript.read_text().splitlines()]
        matching=[r for r in records[-15:] if '[Request interrupted by user' in json.dumps(r)]
        save('interrupt-claude',{'before':before,'after':after,'idleObservedMs':elapsed,'transcriptInterruptRecords':len(matching),'eventsAfterEsc':[r['body'].get('hook_event_name') for r in hooks(since=q)]})
    elif cmd=='interrupt-codex':
        with open(ROOT/'logs'/'codex-interrupt.log','w') as log:
            p=subprocess.Popen(['node',str(HERE/'rpc.mjs'),'turn','Run python3 hold.py in the terminal, then reply S06_INTERRUPT_UNEXPECTED.'],stdout=log,stderr=log,env=clean_env())
        time.sleep(4);before=rpc('read')
        if before['status']['type']!='active':raise SystemExit('Codex not active')
        q=time.time()*1000;tmux('send-keys','-t','s06:codex','Escape')
        after=None
        for n in range(40):
            after=rpc('read')
            if after['turns'][-1]['status']!='inProgress':break
            time.sleep(.1)
        elapsed=time.time()*1000-q;p.wait(timeout=15)
        save('interrupt-codex',{'before':before,'after':after,'interruptObservedMs':elapsed})
    elif cmd=='exit':
        c,events=control();time.sleep(.5)
        q=time.time()*1000;tmux('send-keys','-t','s06:codex','C-c');time.sleep(.3);tmux('send-keys','-t','s06:codex','C-c')
        while time.time()*1000-q<8000:
            p=next(x for x in pane_facts() if x['window']=='codex')
            if p['dead']:break
            time.sleep(.1)
        elapsed=time.time()*1000-q;time.sleep(1)
        save('exit',{'pane':p,'deadObservedMs':elapsed,'controlAlive':c.poll() is None,'exitNotifications':[e for e in events if e['line'].startswith('%exit')],'controlEvents':events})
        c.stdin.write('detach-client\n');c.stdin.flush();c.wait(timeout=5)
        tmux('respawn-pane','-t','s06:codex','-c',str(ROOT/'repo'),'-e',f'CODEX_HOME={ROOT}/home','codex','resume',(ROOT/'codex-thread-id').read_text().strip(),'--remote',f'unix://{ROOT}/codex.sock','-c','model="gpt-5.6-luna"')
    elif cmd=='discover':
        # A fresh process reads only tmux metadata and stored IDs. No terminal text.
        rows=pane_facts();cwd=(ROOT/'repo').resolve()
        matches=[r for r in rows if r['cwd'] and pathlib.Path(r['cwd']).resolve()==cwd]
        save('discovery',{'matchingPanes':matches,'claude':native(),'codex':rpc('read'),'note':'cwd joins the task; pid/command alone does not uniquely identify provider/thread when multiple panes share cwd'})
    else:raise SystemExit('Unknown lifecycle action')

if __name__=="__main__": main()
