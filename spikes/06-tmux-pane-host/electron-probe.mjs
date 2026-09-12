// Reuses spike 03's exact terminal main/preload/renderer and keydown -> parsed-cursor metric.
import {_electron as electron} from 'playwright';
import {execFileSync} from 'node:child_process';
import {readFileSync,writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const here=path.dirname(fileURLToPath(import.meta.url));
const root=path.join(process.env.TMPDIR,'loom-spike-06');
const mode=process.argv[2]??'latency';
if(process.env.LOOM_REAL_PROVIDERS!=='1')throw new Error('Set LOOM_REAL_PROVIDERS=1 for manual terminal probes');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const tmux=(...args)=>execFileSync('/opt/homebrew/bin/tmux',['-L','loom-s06',...args],{encoding:'utf8'}).trim();
const env=Object.fromEntries(Object.entries(process.env).filter(([k])=>!k.startsWith('HERDR_')&&!k.startsWith('CLAUDE_CODE_')&&!['CLAUDECODE','TMUX','TMUX_PANE'].includes(k)));
const app=await electron.launch({args:[here],cwd:here,env:{...env,S03_QUERY:'keyfix=1&graphemes=1'}});
const result={mode};
try{
 const page=await app.firstWindow();await page.waitForFunction(()=>window.s03!==undefined);
 const open=async target=>{
  const id=await page.evaluate(o=>window.s03.open(o),{file:'/opt/homebrew/bin/tmux',args:['-L','loom-s06','attach','-t',target],cwd:`${root}/repo`,title:target});
  await sleep(1000);return id;
 };
 const screen=id=>page.evaluate(id=>window.s03.screenText(id),id);
 const stats=xs=>{const s=[...xs].sort((a,b)=>a-b);const q=p=>+s[Math.min(s.length-1,Math.floor(s.length*p))]?.toFixed(2);return {n:s.length,p50:q(.5),p95:q(.95),max:q(1),samples:xs};};
 if(mode==='latency'){
  result.runs=[];
  for(let rep=0;rep<3;rep++){
   const run={};
   for(const target of ['local','s06:anchor','s06:claude']){
    const id=target==='local'?await page.evaluate(()=>window.s03.open({file:'/bin/cat',title:'local cat'})):await open(target);
    await sleep(600);await page.evaluate(id=>{window.s03.focus(id);window.s03.resetLatencies()},id);
    for(let i=0;i<30;i++){await page.keyboard.type(String.fromCharCode(97+i%26));await sleep(80)}
    await sleep(300);run[target]=stats(await page.evaluate(()=>[...window.s03.latencies]));
    if(target==='s06:claude'){for(let i=0;i<30;i++)await page.keyboard.press('Backspace');await sleep(300);}
    run[target].terminal=await page.evaluate(id=>window.s03.info(id),id);
    await page.evaluate(id=>window.s03.close(id),id);
   }
   result.runs.push(run);console.log(JSON.stringify({rep,summary:Object.fromEntries(Object.entries(run).map(([k,v])=>[k,{n:v.n,p50:v.p50,p95:v.p95,max:v.max}]))}));
  }
 }else if(mode==='keys'){
  const id=await open('s06:keys');result.before=await screen(id);
  const log=()=>readFileSync(`${root}/keylog.txt`,'utf8');
  const step=async(name,fn)=>{const before=log().length;await fn();await sleep(400);result[name]={sent:await page.evaluate(id=>window.s03.inputLog(id),id),received:log().slice(before)};await page.evaluate(id=>window.s03.clearInputLog(id),id);};
  await step('shiftEnter',()=>page.keyboard.press('Shift+Enter'));
  await step('paste',()=>page.evaluate(()=>window.s03.synthPaste('S06-line1\nS06-line2')));
  const box=await page.locator('.term').boundingBox();
  await step('mouse',()=>page.mouse.click(box.x+80,box.y+40));
  await step('wheel',async()=>{await page.mouse.move(box.x+80,box.y+40);await page.mouse.wheel(0,-200)});
  result.after=await screen(id);await page.screenshot({path:`${root}/keys.png`});
 }else if(mode==='shift-agents'){
  result.agents={};
  for(const target of ['s06:claude','s06:codex']){
   const id=await open(target);const before=Date.now();await page.keyboard.type('a');await sleep(600);await page.keyboard.press('Shift+Enter');await sleep(600);await page.keyboard.type('b');await sleep(600);
   result.agents[target]={startMs:before,sent:await page.evaluate(id=>window.s03.inputLog(id),id),screen:await screen(id)};
   await page.screenshot({path:`${root}/shift-${target.split(':')[1]}.png`});
   for(let i=0;i<4;i++)await page.keyboard.press('Backspace');await sleep(300);await page.evaluate(id=>window.s03.close(id),id);
  }
 }else if(mode==='ghostty'){
  const id=await open('s06:anchor');
  const snapshot=()=>({clients:tmux('list-clients','-F','#{client_name}|#{client_width}x#{client_height}|#{client_activity}'),pane:tmux('display-message','-p','-t','s06:anchor','#{pane_width}x#{pane_height}'),screen:null});
  result.before=snapshot();
  const script=['tell application "Ghostty"','set cfg to new surface configuration','set command of cfg to "/opt/homebrew/bin/tmux -L loom-s06 attach -t s06:anchor"','set w to new window with configuration cfg','return id of w','end tell'].flatMap(x=>['-e',x]);
  const windowId=execFileSync('osascript',script,{encoding:'utf8'}).trim();writeFileSync(`${root}/ghostty-window-id`,windowId);result.windowId=windowId;
  try{
   await sleep(2500);result.both=snapshot();
   await page.evaluate(id=>window.s03.focus(id),id);await page.keyboard.type('S06_FROM_ELECTRON');await sleep(500);result.afterElectron=snapshot();
   // Select only the window we just created; never access other terminals.
   const ghost=(body)=>execFileSync('osascript',['-e','tell application "Ghostty"','-e',`set w to first window whose id is "${windowId}"`,'-e','set t to focused terminal of selected tab of w','-e',body,'-e','end tell'],{encoding:'utf8'}).trim();
   result.ghosttyVisual='Not verified: computer-use access to Ghostty is blocked';
   ghost('input text "S06_FROM_GHOSTTY" to t');await sleep(500);
   result.afterGhostty=snapshot();result.electronText=await screen(id);
   // Resize Electron, then type: latest active client should govern sizes.
   await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(900,600));await sleep(600);await page.keyboard.type('x');await sleep(300);result.resized=snapshot();
   await page.screenshot({path:`${root}/two-clients.png`});
  }finally{
   const initial=new Set(result.before.clients.split('\n').map(l=>l.split('|')[0]));
   for(const line of tmux('list-clients','-F','#{client_name}').split('\n')){if(line && !initial.has(line))tmux('detach-client','-t',line);}
   execFileSync('osascript',['-e',`tell application "Ghostty" to close window (first window whose id is "${windowId}")`]);}
  await sleep(300);result.afterGhosttyClose=snapshot();
 }else if(mode==='scroll'){
  const names=tmux('list-windows','-t','s06','-F','#{window_name}').split('\n');
  if(!names.includes('scroll'))tmux('new-window','-d','-t','s06:','-n','scroll','-c',`${root}/repo`,'/bin/sh','-c','seq 1 500; exec /bin/cat');
  else if(tmux('display-message','-p','-t','s06:scroll','#{pane_in_mode}')==='1')tmux('send-keys','-t','s06:scroll','-X','cancel');
  const id=await open('s06:scroll');result.before=await screen(id);
  const box=await page.locator('.term').boundingBox();await page.mouse.move(box.x+100,box.y+100);for(let n=0;n<5;n++){await page.mouse.wheel(0,-100);await sleep(150)}await sleep(600);
  result.after=await screen(id);result.copyMode=tmux('display-message','-p','-t','s06:scroll','#{pane_in_mode}|#{scroll_position}');await page.screenshot({path:`${root}/scroll.png`});
 }else throw new Error('Unknown mode');
} catch(e){result.error=e.stack;process.exitCode=1;}finally{
 writeFileSync(`${root}/electron-${mode}.json`,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));await app.close();
}
