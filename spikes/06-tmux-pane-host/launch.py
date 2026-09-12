from common import *
require_real()
allowed={'HOME','USER','LOGNAME','PATH','TMPDIR','SHELL','LANG','LC_ALL','LC_CTYPE','TERM','COLORTERM'}
# tmux has no environment allowlist primitive. Mark every unwanted inherited name for removal.
keys=[]
for line in tmux('show-environment','-g').splitlines():
    name=line.split('=',1)[0].lstrip('-')
    if name not in allowed:
        tmux('set-environment','-r','-t','s06',name); keys.append(name)
(ROOT/'environment-removals.json').write_text(json.dumps(keys))
print('removed inherited variables:',len(keys))
print('claude pane',launch('claude'))
