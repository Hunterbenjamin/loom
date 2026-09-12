"""Owned spike fixture. Run once; refuses an existing directory or tmux server."""
import json, os, pathlib, shutil, subprocess, time, uuid
HERE = pathlib.Path(__file__).resolve().parent
ROOT = pathlib.Path(os.environ['TMPDIR']) / 'loom-spike-06'
TMUX = ['/opt/homebrew/bin/tmux', '-L', 'loom-s06']

def clean_env():
    return {k:v for k,v in os.environ.items() if not k.startswith(('CLAUDE_CODE_', 'HERDR_')) and k not in {'CLAUDECODE','CLAUDE_PID','CLAUDE_EFFORT','TMUX','TMUX_PANE'}}

def main():
    if ROOT.exists(): raise SystemExit('Refusing existing spike directory')
    check = subprocess.run(TMUX + ['list-sessions'], capture_output=True)
    if check.returncode == 0: raise SystemExit('Refusing existing loom-s06 server')
    if b'Operation not permitted' in check.stderr: raise SystemExit('Sandbox blocks tmux; rerun with approval')
    ROOT.mkdir(mode=0o700)
    (ROOT/'repo').mkdir(); (ROOT/'home').mkdir(); (ROOT/'logs').mkdir()
    subprocess.run(['git','init','-q',str(ROOT/'repo')],check=True)
    (ROOT/'repo'/'README.md').write_text('Isolated Loom spike 06 fixture.\n')
    source = pathlib.Path(os.environ.get('CODEX_HOME', str(pathlib.Path.home()/'.codex'))) / 'auth.json'
    if not source.is_file(): raise SystemExit('Existing Codex CLI authentication required')
    # Reuse CLI authentication without reading or printing it, as spike 01 does.
    (ROOT/'home'/'auth.json').symlink_to(source)
    (ROOT/'home'/'config.toml').write_text('model = "gpt-5.6-luna"\nmodel_reasoning_effort = "low"\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"\n[analytics]\nenabled = false\n')
    sid=str(uuid.uuid4()); (ROOT/'claude-session-id').write_text(sid)
    settings=json.loads((HERE.parent/'02-claude-hooks'/'hooks.settings.json').read_text().replace('47802','47806'))
    settings['permissions']['allow'] += ['Bash(python3 *env-probe.py*)','Bash(python3 *hold.py*)']
    (ROOT/'settings.json').write_text(json.dumps(settings,indent=2))
    (ROOT/'repo'/'hold.py').write_text('import time\ntime.sleep(25)\nprint("S06_HOLD_DONE")\n')
    (ROOT/'repo'/'env-probe.py').write_text('import json,os\nprint(json.dumps({"scrubbed_present": sorted(k for k in os.environ if k.startswith(("CLAUDE_CODE_", "HERDR_"))), "sentinel": os.environ.get("S06_SERVER_SENTINEL"), "keys": sorted(os.environ)}))\n')
    (ROOT/'tmux.conf').write_text('set -g mouse on\nset -g status off\nset -g update-environment ""\nset -g default-shell /bin/sh\nset -g remain-on-exit on\nset -g window-size latest\nset -g aggressive-resize on\nset -g automatic-rename off\nset -s escape-time 10\n')
    env=clean_env()
    # Deliberate harmless markers probe server inheritance; no real secrets printed.
    env.update(S06_SERVER_SENTINEL='server-only', CLAUDE_CODE_S06='fake', HERDR_S06='fake')
    started=time.time(); (ROOT/'first-experiment.json').write_text(json.dumps({'utc':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime(started)), 'epoch':started}))
    (ROOT/'owned-pids.json').write_text('{}')
    subprocess.run(TMUX+['-f',str(ROOT/'tmux.conf'),'new-session','-d','-s','s06','-n','anchor','-c',str(ROOT/'repo'),'/bin/cat'],env=env,check=True)
    subprocess.run(TMUX+['list-sessions'],env=env,check=True,capture_output=True)
    owned={}
    for name, args in [('hooks',['node',str(HERE/'hook-server.mjs'),'47806',str(ROOT/'hooks.jsonl')]),('codex-server',['codex','app-server','--listen',f'unix://{ROOT}/codex.sock'])]:
        with open(ROOT/'logs'/f'{name}.log','ab') as log:
            p=subprocess.Popen(args,cwd=ROOT/'repo',env={**clean_env(),'CODEX_HOME':str(ROOT/'home')},stdout=log,stderr=log,start_new_session=True)
        owned[name]=p.pid
    (ROOT/'owned-pids.json').write_text(json.dumps(owned))
    print(json.dumps({'root':str(ROOT),'claudeSessionId':sid,'owned':owned,'firstExperiment':started}))

if __name__=='__main__': main()
