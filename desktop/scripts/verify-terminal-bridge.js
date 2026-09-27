'use strict'
// Isolated bridge protocol tests: no existing task UI or terminal contents are read.
const assert = require('node:assert/strict'), path = require('node:path'), fs = require('node:fs'), os = require('node:os')
const { spawn } = require('node:child_process')
const { createRPC } = require('../src/terminal/rpc')
async function main() {
  if (process.platform === 'win32') {
    const { createWindowsTerminal } = require('../src/terminal/windows')
    const bridge = createWindowsTerminal()
    try {
      const result = await bridge.request('bind', { tasks: [] }); assert.deepEqual(result.bindings, [])
      const missing = await bridge.request('view', { locator: { version:1,os:'win32',pid:2147483640,start:'0',window:'0' } })
      assert.equal(missing.valid, false)
      console.log('Windows helper compiled; protocol and dead-process rejection passed')
    } finally { bridge.stop() }
    return
  }
  if (process.platform !== 'darwin') return
  const home = fs.mkdtempSync(path.join(os.tmpdir(),'allpet-terminal-rpc-'))
  const child=spawn(process.env.ALLPET_BINARY || path.resolve(__dirname,'../../.build/release/allpet'),['menu-bridge'],{
    env:{...process.env,ALLPET_HOME:home,ALLPET_BRIDGE_HEADLESS:'1'},stdio:['pipe','pipe','pipe'] })
  let buffer=''; const rpc=createRPC(request=>{child.stdin.write(JSON.stringify(request)+'\n');return true})
  const ready=new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(Error('bridge did not start')),5000)
    child.on('error',reject); child.on('close',()=>rpc.disconnect())
    child.stdout.on('data',chunk=>{buffer+=chunk;let index;while((index=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,index);buffer=buffer.slice(index+1);const message=JSON.parse(line);if(message.type==='ready'){clearTimeout(timer);resolve()};rpc.receive(message)}})
  })
  try {
    await ready
    assert.deepEqual((await rpc.request('bind',{tasks:[{id:'codex|missing',platform:'codex',title:'fixture',action:'fixture',phase:'done',sessionID:'allpet-fixture-does-not-exist',launchOrigin:'codex-cli',sourcePath:path.join(home,'missing')}] })).bindings,[])
    const stale={tty:'/dev/ttys999',anchorProcessID:2147483640,anchorStartedAtMicroseconds:1}
    assert.equal((await rpc.request('valid',{binding:stale})).valid,false)
    assert.equal((await rpc.request('view',{binding:stale})).viewed,false)
    assert.equal((await rpc.request('focus',{binding:stale})).succeeded,false)
    console.log('macOS headless bridge bind/view/focus protocol passed; stale identity rejected')
  } finally { rpc.disconnect(); child.kill(); fs.rmSync(home,{recursive:true,force:true}) }
}
main().catch(error=>{console.error(error);process.exitCode=1})
