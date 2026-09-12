"""Kill only loom-s06 with both owned providers mid-tool, reconstruct panes from IDs."""
from lifecycle import *
require_real()
trial=sys.argv[1] if len(sys.argv)>1 else '1'
if not trial.isdigit():raise SystemExit('Numeric trial required')
# Read-only state guards before a destructive experiment; no shared servers are touched.
if native().get('status')!='idle' or rpc('read')['status']['type']!='idle':raise SystemExit('Providers must start idle')
claude_started=send('Use Bash to run exactly python3 hold.py, then reply S06_RESTART_CLAUDE_DONE.')
if not wait_hook('PreToolUse',claude_started,30):raise SystemExit('Claude did not start tool')
with open(ROOT/'logs'/f'codex-restart-{trial}.log','w') as log:
    turn_process=subprocess.Popen(['node',str(HERE/'rpc.mjs'),'turn','Run python3 hold.py using exec_command with yield_time_ms 30000. Wait for it to exit and confirm S06_HOLD_DONE in the tool result before replying S06_RESTART_CODEX_DONE. If it returns a session ID, keep polling that tool session until it exits.'],stdout=log,stderr=log,env=clean_env())
# Live command items can be absent from thread/read until completion. Correlate native
# item/started notifications with a fresh active thread snapshot, never screen text.
for n in range(100):
    before_codex=rpc('read');turn=before_codex['turns'][-1]
    events_now=[json.loads(l) for l in (ROOT/'rpc-events.jsonl').read_text().splitlines()]
    commands=[e for e in events_now if e['time']>=claude_started and e.get('threadId')==before_codex['id'] and e.get('method')=='item/started' and e.get('item',{}).get('type')=='commandExecution']
    if commands and commands[-1].get('turnId')==turn['id'] and before_codex['status']['type']=='active' and turn['status']=='inProgress':break
    time.sleep(.2)
else:raise SystemExit('Codex never entered native in-progress command')
before_claude=native()
if before_claude['status']!='busy':raise SystemExit('Claude no longer mid-turn')
c,events=control();time.sleep(.2)
rows=pane_facts();server_pid=json.loads((ROOT/'owned-pids.json').read_text())['codex-server']
q=time.time()*1000
(ROOT/f'restart-{trial}-checkpoint.json').write_text(json.dumps({'faultMs':q,'beforeClaude':before_claude,'beforeCodex':turn,'nativeCommandStarted':commands[-1],'serverPid':server_pid,'oldPanes':rows}))
print(json.dumps({'trial':trial,'faultMs':q,'beforeClaude':before_claude,'beforeCodex':turn,'nativeCommandStarted':commands[-1],'serverPid':server_pid}),flush=True)
tmux('kill-server')
c.wait(timeout=10)
down_ms=time.time()*1000-q
# No auto-restore. Start the exact private server and reconstruct from stored launch recipe.
env={k:v for k,v in clean_env().items() if k in {'HOME','USER','LOGNAME','PATH','TMPDIR','SHELL','LANG','LC_ALL','LC_CTYPE','TERM','COLORTERM'}}
subprocess.run(TMUX+['-f',str(ROOT/'tmux.conf'),'new-session','-d','-s','s06','-n','anchor','-c',str(ROOT/'repo'),'/bin/cat'],env=env,check=True)
server_up_ms=time.time()*1000-q
print('new server ready',round(server_up_ms),flush=True)
new_claude=launch('claude',True);new_codex=launch('codex',True)
launched_ms=time.time()*1000-q
for n in range(120):
    resumed=next((r for r in hooks('SessionStart',q) if r['body'].get('source')=='resume'),None)
    p=native()
    if resumed and p and p['status']=='idle':break
    time.sleep(.1)
claude_ready_ms=time.time()*1000-q
# Provider turn completion must survive the death of the terminal host.
turn_process.wait(timeout=90)
after_codex=rpc('read');finished=next(t for t in after_codex['turns'] if t['id']==turn['id'])
old_agents=[r for r in rows if r['window'] in {'claude','codex'}]
# Both providers must answer a fresh prompt; never infer readiness from terminal text.
t=send(f'Reply exactly S06_RECOVERED_CLAUDE_{trial}. Do not use tools.')
stop=wait_hook('Stop',t,40)
codex_fresh_sent=send(f'Reply exactly S06_RECOVERED_CODEX_{trial}. Do not use tools.','s06:codex')
for n in range(100):
    fresh=rpc('read')['turns'][-1]
    if fresh['id']!=turn['id'] and fresh['status']!='inProgress':break
    time.sleep(.2)
ack={'turnId':fresh['id'],'status':fresh['status'],'reply':[i['text'] for i in fresh['items'] if i['type']=='agentMessage'],'sentVia':'tmux paste + Enter'}
if fresh['id']==turn['id'] or fresh['status']!='completed':raise SystemExit('TUI did not deliver a fresh Codex turn')
end_ms=time.time()*1000-q
save('restart-'+trial,{'trial':trial,'faultMs':q,'downMs':down_ms,'serverUpMs':server_up_ms,'panesLaunchedMs':launched_ms,'claudeReadyMs':claude_ready_ms,'bothFreshRepliesMs':end_ms,'oldPaneProcessesAlive':{r['window']:alive(r['pid']) for r in old_agents},'externalCodexServerAlive':alive(server_pid),'nativeCommandStarted':commands[-1],'beforeClaude':before_claude,'afterClaude':native(),'claudeSessionStartSource':resumed['body'].get('source') if resumed else None,'claudeReply':stop['body'].get('last_assistant_message') if stop else None,'codexMidTurnId':turn['id'],'codexMidTurnFinal':finished,'codexFreshReply':ack,'newPanes':pane_facts(),'controlExitEvents':[e for e in events if e['line'].startswith('%exit')]})
