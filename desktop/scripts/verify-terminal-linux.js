'use strict'
// Requires an isolated X11 session with xfce4-terminal, openbox, python3-pyatspi and xdotool.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {spawn,execFileSync}=require('node:child_process')
const {createTerminalService,applyBindings}=require('../src/terminal/service')
const {run}=require('../src/terminal/process')
const home=fs.mkdtempSync(path.join(os.tmpdir(),'allpet-linux-terminal-')),pids=[],children=[]
const quote=s=>"'"+s.replaceAll("'","'\\''")+"'", wait=ms=>new Promise(r=>setTimeout(r,ms))
let service, tasks=[]
async function main(){
 fs.writeFileSync(path.join(home,'fixture.c'),'#include <stdio.h>\n#include <unistd.h>\nint main(int n,char**a){FILE*f=fopen(a[1],"a");FILE*p=fopen(a[2],"w");fprintf(p,"%d",getpid());fclose(p);while(1)sleep(1);return f?0:1;}')
 execFileSync('cc',[path.join(home,'fixture.c'),'-o',path.join(home,'codex')])
 for(let i=0;i<2;i++){
  const source=path.join(home,`source${i}.jsonl`),pidfile=path.join(home,`pid${i}`)
  const command=[path.join(home,'codex'),source,pidfile].map(quote).join(' ')+'; exec bash --norc'
  children.push(spawn('xfce4-terminal',['--disable-server','--command',`bash --norc -c ${quote(command)}`],{stdio:'ignore'}))
  for(let j=0;j<100&&!fs.existsSync(pidfile);j++) await wait(100)
  pids.push(Number(fs.readFileSync(pidfile,'utf8')))
 }
 tasks=[{id:'codex|fixture',platform:'codex',title:'fixture',action:'fixture',sessionID:'fixture',phase:'done',launchOrigin:'codex-cli',updatedAt:(Date.now()-978307200000)/1000,sourcePath:path.join(home,'source0.jsonl'),processID:pids[0]}]
 service=createTerminalService({home,getTasks:()=>tasks,config:()=>({}),onBindings:(inspected,updates)=>applyBindings(tasks,inspected,updates)})
 await service.capture(); assert.ok(tasks[0].terminalLocator)
 assert.equal(await service.viewed(tasks[0]),false,'other terminal is foreground')
 const start=Date.now(),result=await service.focus(tasks[0]);assert.equal(result.exact,true,JSON.stringify(result))
 assert.equal(await service.viewed(tasks[0]),true);const latency=Date.now()-start
 process.kill(pids[0],'SIGTERM');await wait(150)
 assert.equal(await service.viewed(tasks[0]),true,'shell binding survives child exit')
 console.log(JSON.stringify({ok:true,wrongTerminalRejected:true,exactFocus:true,focusAndViewMilliseconds:latency,bindingSurvivesAgentExit:true}))
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(async()=>{
 service?.stop()
 for(const pid of pids)try{process.kill(pid,'SIGTERM')}catch{}
 for(const child of children)try{child.kill()}catch{}
 fs.rmSync(home,{recursive:true,force:true})
})
