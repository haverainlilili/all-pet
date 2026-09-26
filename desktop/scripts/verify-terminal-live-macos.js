'use strict'
// Opens and closes only two synthetic fixture terminals. Run explicitly on macOS.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {spawn,execFileSync}=require('node:child_process')
const root=path.resolve(__dirname,'../..'), {run}=require(path.join(root,'desktop/src/terminal/process')), {createRPC}=require(path.join(root,'desktop/src/terminal/rpc'))
const home=fs.mkdtempSync(path.join(os.tmpdir(),'allpet-own-terminal-')),tabs=[],pids=[]
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'", apple=s=>JSON.stringify(s)
const child=spawn(path.join(root,'.build/release/allpet'),['menu-bridge'],{env:{...process.env,ALLPET_HOME:home,ALLPET_BRIDGE_HEADLESS:'1'},stdio:['pipe','pipe','inherit']})
const rpc=createRPC(m=>{child.stdin.write(JSON.stringify(m)+'\n');return true},{timeoutMs:4000})
let buffer=''; const ready=new Promise(resolve=>child.stdout.on('data',data=>{buffer+=data;let n;while((n=buffer.indexOf('\n'))>=0){const m=JSON.parse(buffer.slice(0,n));buffer=buffer.slice(n+1);if(m.type==='ready')resolve();rpc.receive(m)}}))
const as=source=>run('/usr/bin/osascript',['-e',source],{timeout:6000})
const wait=ms=>new Promise(r=>setTimeout(r,ms))
async function main(){
 await ready
 fs.writeFileSync(path.join(home,'fixture.c'),'#include <stdio.h>\n#include <unistd.h>\nint main(int n,char**a){FILE*f=fopen(a[1],"a");FILE*p=fopen(a[2],"w");fprintf(p,"%d",getpid());fclose(p);while(1)sleep(1);return f?0:1;}')
 execFileSync('/usr/bin/cc',[path.join(home,'fixture.c'),'-o',path.join(home,'codex')])
 for(let i=0;i<2;i++){
  const source=path.join(home,`source${i}.jsonl`),pidfile=path.join(home,`pid${i}`)
  const command=[path.join(home,'codex'),source,pidfile].map(quote).join(' ')
  const tty=await as(`tell application id "com.apple.Terminal"\nset t to do script ${apple(command)}\nreturn tty of t\nend tell`)
  tabs.push(tty)
  for(let t=0;t<50&&!fs.existsSync(pidfile);t++)await wait(100)
  pids.push(Number(fs.readFileSync(pidfile,'utf8')))
 }
 const task={id:'codex|allpet-own-fixture',platform:'codex',title:'AllPet fixture',action:'fixture',phase:'done',updatedAt:(Date.now()-978307200000)/1000,sessionID:'allpet-own-fixture',sourcePath:path.join(home,'source0.jsonl'),processID:pids[0],launchOrigin:'codex-cli'}
 const bindings=(await rpc.request('bind',{tasks:[task]})).bindings;assert.equal(bindings.length,1)
 const binding=bindings[0].terminalBinding;assert.equal(binding.tty,tabs[0])
 const wrong=await rpc.request('view',{binding});assert.equal(wrong.viewed,false)
 const before=Date.now(),focused=await rpc.request('focus',{binding});assert.equal(focused.succeeded,true)
 const view=await rpc.request('view',{binding});assert.equal(view.viewed,true);const ms=Date.now()-before;assert.ok(ms<2000,`latency ${ms}`)
 process.kill(pids[0],'SIGTERM');await wait(150)
 assert.equal((await rpc.request('valid',{binding})).valid,true)
 assert.equal((await rpc.request('view',{binding})).viewed,true)
 console.log(JSON.stringify({ok:true,wrongTabRejected:true,exactFocus:true,focusAndViewMilliseconds:ms,bindingSurvivesAgentExit:true}))
}
main().catch(e=>{console.error(e);process.exitCode=1}).finally(async()=>{
 for(const pid of pids)try{process.kill(pid,'SIGTERM')}catch{}
 await wait(150)
 for(const tty of tabs)try{await as(`tell application id "com.apple.Terminal"\nrepeat with w in windows\nrepeat with t in tabs of w\nif tty of t is ${apple(tty)} then\nclose t\nexit repeat\nend if\nend repeat\nend repeat\nend tell`)}catch{}
 rpc.disconnect();child.kill();fs.rmSync(home,{recursive:true,force:true})
})
