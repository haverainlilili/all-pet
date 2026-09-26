'use strict'
// Run only in an isolated CI desktop. Creates two tabs in a dedicated portable WT window.
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict')
const {spawn,execFileSync}=require('node:child_process')
const {createWindowsTerminal}=require('../src/terminal/windows')
const home=fs.mkdtempSync(path.join(process.env.RUNNER_TEMP||os.tmpdir(),'allpet-wt-fixture-')),pids=[],bridge=createWindowsTerminal()
const quote=s=>'"'+s.replaceAll('"','\\"')+'"', ps=s=>"'"+s.replaceAll("'","''")+"'", wait=ms=>new Promise(r=>setTimeout(r,ms))
const terminal=process.env.ALLPET_WINDOWS_TERMINAL,windowName='allpet-fixture-'+Date.now()
async function main(){
 if(!terminal) throw Error('ALLPET_WINDOWS_TERMINAL must point to the isolated portable WindowsTerminal.exe')
 const source=path.join(home,'fixture.cs'),exe=path.join(home,'codex.exe')
 fs.writeFileSync(source,'using System;using System.IO;using System.Diagnostics;using System.Threading;class Fixture{static void Main(string[] a){using(var f=new FileStream(a[0],FileMode.OpenOrCreate,FileAccess.Write,FileShare.ReadWrite)){File.WriteAllText(a[1],Process.GetCurrentProcess().Id.ToString());while(true)Thread.Sleep(1000);}}}')
 const compiler=path.join(home,'compile.ps1');fs.writeFileSync(compiler,`$ErrorActionPreference='Stop'\nAdd-Type -Path ${ps(source)} -OutputAssembly ${ps(exe)} -OutputType ConsoleApplication\n`)
 execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',compiler],{stdio:'inherit'})
 let locator
 for(let i=0;i<2;i++){
  const log=path.join(home,`log${i}.jsonl`),pidfile=path.join(home,`pid${i}`)
  const child=spawn(terminal,['-w',windowName,'new-tab','--title',`AllPet fixture ${i}`,'--useApplicationTitle','cmd.exe','/d','/k',[exe,log,pidfile].map(quote).join(' ')],{stdio:'ignore',windowsHide:false});child.on('error',error=>console.error(error.message));child.unref()
  for(let n=0;n<150&&!fs.existsSync(pidfile);n++)await wait(100)
  assert.ok(fs.existsSync(pidfile),'fixture process started in its own terminal tab')
  pids.push(Number(fs.readFileSync(pidfile,'utf8')));await wait(500)
  if(i===0){
   const task={id:'codex|fixture',platform:'codex',phase:'done',title:'fixture',action:'fixture',sessionID:'fixture',sourcePath:log,processID:pids[0],launchOrigin:'codex-cli',updatedAt:(Date.now()-978307200000)/1000}
   const result=await bridge.request('bind',{tasks:[task]});locator=result.bindings?.[0]?.terminalLocator
   assert.ok(locator?.window&&locator.control?.length,'bound the exact Windows Terminal control')
  }
 }
 assert.equal((await bridge.request('view',{locator})).viewed,false,'other tab cannot acknowledge')
 const started=Date.now();assert.equal((await bridge.request('focus',{locator})).succeeded,true,'original tab and pane focused')
 assert.equal((await bridge.request('view',{locator})).viewed,true)
 const elapsed=Date.now()-started;process.kill(pids[0]);await wait(200)
 assert.equal((await bridge.request('view',{locator})).viewed,true,'binding survives agent exit')
 console.log(JSON.stringify({ok:true,wrongTabRejected:true,exactFocus:true,focusAndViewMilliseconds:elapsed,bindingSurvivesAgentExit:true}))
}
main().catch(error=>{console.error(error);process.exitCode=1}).finally(()=>{
 bridge.stop();for(const pid of pids)try{execFileSync('taskkill.exe',['/PID',String(pid),'/T','/F'],{stdio:'ignore'})}catch{}
 // The portable process belongs exclusively to this isolated CI step.
 try{execFileSync('taskkill.exe',['/IM','WindowsTerminal.exe','/T','/F'],{stdio:'ignore'})}catch{}
 fs.rmSync(home,{recursive:true,force:true,maxRetries:5,retryDelay:100})
})
