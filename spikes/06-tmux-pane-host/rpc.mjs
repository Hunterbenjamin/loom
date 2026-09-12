// Spike 05's ws+unix transport, with bounded requests and validation at the boundary.
import WebSocket from 'ws';
import {z} from 'zod';
import {readFileSync,writeFileSync,appendFileSync} from 'node:fs';
import path from 'node:path';
const root=path.join(process.env.TMPDIR,'loom-spike-06');
const [action,...rest]=process.argv.slice(2);
if(['start','turn'].includes(action)&&process.env.LOOM_REAL_PROVIDERS!=='1')throw new Error('Set LOOM_REAL_PROVIDERS=1 for real-provider probes');
const json=z.record(z.string(),z.unknown());
const envelope=z.object({id:z.union([z.string(),z.number()]).optional(),method:z.string().optional(),params:json.optional(),result:z.unknown().optional(),error:z.unknown().optional()});
const threadSchema=z.object({thread:z.object({id:z.string(),status:json.optional(),turns:z.array(json).optional()}).passthrough()}).passthrough();
const ws=new WebSocket(`ws+unix://${root}/codex.sock:/rpc`,{headers:{Host:'localhost'},perMessageDeflate:false});
const pending=new Map(); let next=1;
const log=(v)=>appendFileSync(`${root}/rpc-events.jsonl`,JSON.stringify({time:Date.now(),...v})+'\n');
ws.on('message',raw=>{
  const m=envelope.parse(JSON.parse(raw.toString()));
  if(m.id!==undefined && pending.has(m.id)) {const p=pending.get(m.id);pending.delete(m.id);clearTimeout(p.timer);m.error?p.reject(new Error(JSON.stringify(m.error))):p.resolve(m.result);}
  else if(m.method){
    // Native state only; don't log deltas, rate limits, auth, or unrelated sessions.
    if(['turn/started','turn/completed','thread/status/changed','item/started','item/completed'].includes(m.method)) {
      const p=m.params; const item=p?.item;
      log({method:m.method,threadId:p?.threadId,turnId:p?.turnId,turn:p?.turn?{id:p.turn.id,status:p.turn.status}:undefined,status:p?.status,item:item?{type:item.type,id:item.id,status:item.status,text:item.type==='agentMessage'?item.text:undefined}:undefined});
    }
    if(m.id!==undefined){ log({method:m.method,approval:'unanswered'}); }
  }
});
const call=(method,params)=>new Promise((resolve,reject)=>{const id=next++; const timer=setTimeout(()=>{pending.delete(id);reject(new Error(`timeout ${method}`));},30000);pending.set(id,{resolve,reject,timer});ws.send(JSON.stringify({id,method,params}));});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 await new Promise((resolve,reject)=>{ws.once('open',resolve);ws.once('error',reject)});
 await call('initialize',{clientInfo:{name:'loom-spike-06',version:'0.0.0'},capabilities:{experimentalApi:true}});ws.send(JSON.stringify({method:'initialized',params:{}}));
 if(action==='models'){
  const r=z.object({data:z.array(z.object({id:z.string(),model:z.string(),displayName:z.string(),description:z.string()}).passthrough())}).parse(await call('model/list',{includeHidden:true}));
  console.log(JSON.stringify(r.data.map(({id,model,displayName,description})=>({id,model,displayName,description})),null,2));
 }else if(action==='start'){
  const r=threadSchema.parse(await call('thread/start',{cwd:`${root}/repo`,model:'gpt-5.6-luna',approvalPolicy:'on-request',sandbox:'workspace-write',config:{model_reasoning_effort:'low'}}));
  writeFileSync(`${root}/codex-thread-id`,r.thread.id,{mode:0o600});console.log(JSON.stringify({threadId:r.thread.id}));
  const first=z.object({turn:json}).parse(await call('turn/start',{threadId:r.thread.id,input:[{type:'text',text:'Reply exactly S06_READY. Do not use tools.',text_elements:[]}]}));
  for(let n=0;n<120;n++){await delay(500);const t=threadSchema.parse(await call('thread/read',{threadId:r.thread.id,includeTurns:true})).thread.turns?.find(t=>t.id===first.turn.id);if(t&&t.status!=='inProgress'){console.log(JSON.stringify({firstTurn:t.status}));break;}}
 }else{
  const threadId=z.string().uuid().parse(readFileSync(`${root}/codex-thread-id`,'utf8').trim());
  if(action==='read'){
   const r=threadSchema.parse(await call('thread/read',{threadId,includeTurns:true}));
   console.log(JSON.stringify({id:r.thread.id,status:r.thread.status,turns:r.thread.turns?.map(t=>({id:t.id,status:t.status,items:Array.isArray(t.items)?t.items.map(i=>({type:i.type,text:i.type==='agentMessage'?i.text:undefined,status:i.status})):[]}))}));
  }else{
   await call('thread/resume',{threadId});
   if(action==='turn'){
    const text=rest.join(' ');const r=z.object({turn:json}).parse(await call('turn/start',{threadId,input:[{type:'text',text,text_elements:[]}]}));
    console.log(JSON.stringify({started:r.turn.id}));
    const deadline=Date.now()+120000;
    while(Date.now()<deadline){await delay(500);const s=threadSchema.parse(await call('thread/read',{threadId,includeTurns:true}));const t=s.thread.turns?.find(t=>t.id===r.turn.id);if(t&&t.status!=='inProgress'){console.log(JSON.stringify({turnId:t.id,status:t.status}));break;}}
   }else if(action==='observe'){await delay(Number(rest[0]??60)*1000);}
   else throw new Error('Unknown action');
  }
 }
}catch(e){console.error(e.message);process.exitCode=1;}finally{ws.close();}
