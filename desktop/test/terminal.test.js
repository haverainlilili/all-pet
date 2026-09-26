'use strict'
const test = require('node:test'), assert = require('node:assert/strict')
const fs = require('node:fs'), os = require('node:os'), path = require('node:path')
const { createRPC } = require('../src/terminal/rpc')
const { applyBindings, ownsAnchor } = require('../src/terminal/service')
const { cliTask, parseStat, sanitizeLocator, agentMatches } = require('../src/terminal/process')
const { kittyPanes, tmuxPanes } = require('../src/terminal/unix')
const { createWezTermBridge } = require('../src/terminal/wezterm')
const { performTaskWake } = require('../src/wake')
const { normalizeTaskHistory } = require('../src/task-history')
const { trayPanelLayout } = require('../src/tray-panel-model')

test('Windows cold startup is outside focus deadline and discovery does not block viewing', async () => {
  const { EventEmitter } = require('node:events'), { PassThrough } = require('node:stream')
  const { createWindowsTerminal } = require('../src/terminal/windows')
  const children = []
  const spawnProcess = () => {
    const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough()
    child.kill = () => child.emit('close'); children.push(child)
    setTimeout(() => child.stdout.write('{"type":"terminal-ready"}\n'), 80)
    child.stdin.on('data', data => {
      const message = JSON.parse(data)
      // Slow capture should never hold up a foreground request on its worker.
      setTimeout(() => child.stdout.write(JSON.stringify({ type: 'terminal-result', requestID: message.requestID, viewed: true, bindings: [] }) + '\n'), message.operation === 'bind' ? 120 : 1)
    })
    return child
  }
  const bridge = createWindowsTerminal({ spawnProcess, startupTimeout: 1000, requestTimeout: 40 })
  try {
    let captured = false
    const binding = bridge.request('bind', { tasks: [] }).then(() => { captured = true })
    assert.equal((await bridge.request('view', { locator: {} })).viewed, true)
    assert.equal(captured, false, 'foreground view finishes while discovery is still running')
    await binding; assert.equal(children.length, 2)
  } finally { bridge.stop() }
})

test('terminal RPC times out, cancels on disconnect and ignores old replies', async () => {
  const sent=[], rpc=createRPC(value=>sent.push(value), {timeoutMs:20})
  await assert.rejects(rpc.request('view'), /超时/)
  assert.equal(rpc.receive({type:'terminal-result',requestID:sent[0].requestID,viewed:true}),false)
  const pending=rpc.request('valid'); rpc.disconnect(); await assert.rejects(pending,/断开/)
  const next=rpc.request('view'); rpc.receive({type:'terminal-result',requestID:sent[2].requestID,viewed:false}); assert.equal((await next).viewed,false)
})
test('verified desktop origin overrides old terminal bindings', () => {
  for(const platform of ['codex','claude','pi','grok']) assert.equal(cliTask({platform,launchOrigin:`${platform}-cli`}),true)
  assert.equal(cliTask({platform:'codex',launchOrigin:'codex-desktop',terminalBinding:{tty:'/dev/ttys001'}}),false)
  assert.equal(cliTask({platform:'claude',sessionID:'local_123'}),false)
  assert.equal(cliTask({platform:'codex',sessionID:'unknown'}),false)
})
test('binding replies cannot attach to replaced processes; reused terminals belong to the newer task', () => {
  const old={id:'codex|a',sessionID:'a',processID:12,sourcePath:'/a'}
  const binding={tty:'/dev/ttys000',anchorProcessID:10,anchorStartedAtMicroseconds:100}
  assert.equal(applyBindings([{...old,processID:99}],[old],[{id:old.id,terminalBinding:binding}]),false)
  const done={...old,phase:'done'}; assert.equal(applyBindings([done],[old],[{id:old.id,terminalBinding:binding}]),true)
  assert.deepEqual(done.terminalBinding,binding)
  assert.equal(ownsAnchor({...done,updatedAt:1},[{...done,id:'codex|b',updatedAt:2}]),false)
})
test('process birth identity includes boot; arbitrary script arguments do not identify an agent', () => {
  const fields=Array(22).fill('0'); fields[0]='S'; fields[1]='20'; fields[4]='34817'; fields[19]='900'
  assert.deepEqual(parseStat(`25 (a name ) weird) ${fields.join(' ')}`,'boot'),{pid:25,ppid:20,ttyNumber:'34817',start:'boot:900'})
  assert.equal(agentMatches({exe:'/usr/bin/node',argv:['node','/tmp/reader.js','codex']},'codex'),false)
  assert.equal(agentMatches({exe:'/usr/bin/node',argv:['node','/tools/pi-coding-agent/dist/cli.js']},'pi'),true)
  assert.equal(sanitizeLocator({version:1,os:'linux',pid:5,start:'boot:1',tty:'/tmp/fake'}),undefined)
})
test('portable locators survive restart without extra untrusted fields', () => {
  const locator={version:1,os:'win32',pid:42,start:'123',window:'99',control:[42,21],tab:[42,15]}
  const state=normalizeTaskHistory({platforms:{codex:[{sessionID:'x',phase:'done',updatedAt:(Date.now()-978307200000)/1000,terminalLocator:{...locator,command:'bad'}}]}})
  assert.deepEqual(state.platforms.codex[0].terminalLocator,locator)
})
test('kitty requires focused window/tab/pane; tmux targets stable identifiers', () => {
  const window={is_focused:false,tabs:[{is_focused:true,windows:[{id:4,pid:90,is_focused:true}]}]}
  assert.equal(kittyPanes([window])[0].focused,false); window.is_focused=true; assert.equal(kittyPanes([window])[0].focused,true)
  assert.deepEqual(tmuxPanes('%3\t/dev/pts/1\t1\t@2\t$1\t1')[0],{id:'%3',tty:'/dev/pts/1',active:true,window:'@2',session:'$1',selected:true})
  assert.equal(tmuxPanes('%3;kill-server\t/dev/pts/1\t1\t@2\t$1\t1').length,0)
})
test('WezTerm rejects stale, remote and background focus reports', () => {
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'allpet-wez-')), dir=path.join(home,'.config','all-pet','terminal-bridge')
  fs.mkdirSync(dir,{recursive:true}); const file=path.join(dir,'wezterm-1.json'), report={window:1,focused:true,activePane:2,panes:[{id:2,pid:33,tty:'/dev/ttys002',local:true}]}
  try {
    fs.writeFileSync(file,JSON.stringify(report)); const bridge=createWezTermBridge(home), anchor={pid:33,tty:'/dev/ttys002'}
    assert.equal(bridge.viewed(anchor),true)
    report.focused=false; fs.writeFileSync(file,JSON.stringify(report)); assert.equal(bridge.viewed(anchor),false)
    report.focused=true; report.panes[0].local=false; fs.writeFileSync(file,JSON.stringify(report)); assert.equal(bridge.viewed(anchor),false)
    report.panes[0].local=true; fs.writeFileSync(file,JSON.stringify(report)); fs.utimesSync(file,new Date(0),new Date(0)); assert.equal(bridge.viewed(anchor),false)
  } finally { fs.rmSync(home,{recursive:true,force:true}) }
})
test('CLI click acknowledges before exact focus; mere request acceptance never becomes exact', async () => {
  const order=[],task={id:'codex|x',platform:'codex',sessionID:'x',phase:'done',launchOrigin:'codex-cli'}
  const result=await performTaskWake(task,{dismissTerminalTask:()=>{order.push('dismiss');return true},focusTerminal:async()=>{order.push('focus');return {succeeded:true,exact:true}},presentFallback:()=>{throw Error('unexpected')}})
  assert.deepEqual(order,['dismiss','focus']); assert.equal(result.exact,true); assert.equal(result.acknowledged,true)
  const fallback=await performTaskWake({...task,phase:'running'},{dismissTerminalTask:()=>{throw Error('running')},focusTerminal:async()=>({succeeded:true,exact:false,message:'unverified'}),presentFallback:async plan=>({succeeded:false,...plan})})
  assert.equal(fallback.succeeded,false)
})
test('cascading menu preserves root position at either edge of a negative monitor', () => {
  for(const x of [-1500,-800,-500]) {
    const area={x:-1600,y:0,width:1200,height:900},anchor={x,y:0,width:20,height:22}
    const root=trayPanelLayout(anchor,area), expanded=trayPanelLayout(anchor,area,true)
    assert.ok(expanded.bounds.x>=area.x+8); assert.ok(expanded.bounds.x+expanded.bounds.width<=area.x+area.width-8)
    assert.equal(expanded.bounds.x+(expanded.rootSide==='right'?294:0),root.bounds.x)
  }
})
test('editor bridge requires a fresh authenticated receipt after completion, never a previous selection', async () => {
  const net=require('node:net'), {createDesktopBridges}=require('../src/terminal/desktop-bridges')
  const home=fs.mkdtempSync(path.join(os.tmpdir(),'allpet-editor-')),file=path.join(home,'.config','all-pet','terminal-bridge','connection.json')
  let now=1000, socket; const bridge=createDesktopBridges(home,{now:()=>now}),pause=ms=>new Promise(resolve=>setTimeout(resolve,ms))
  try {
    for(let i=0;i<50&&!fs.existsSync(file);i++) await pause(10)
    const connection=JSON.parse(fs.readFileSync(file,'utf8'))
    socket=net.createConnection(connection.endpoint); await new Promise(resolve=>socket.once('connect',resolve))
    socket.write(JSON.stringify({adapter:'vscode',token:connection.token})+'\n')
    socket.write(JSON.stringify({type:'state',terminals:[{id:'one',pid:42,local:true,focused:true,viewedAt:900}]})+'\n')
    for(let i=0;i<30&&!bridge.has({pid:42});i++)await pause(10)
    assert.equal(bridge.viewed({pid:42,completedAt:901}),false)
    assert.equal(bridge.viewed({pid:42,completedAt:800}),true)
    now=2500;assert.equal(bridge.viewed({pid:42,completedAt:800}),false)
  } finally { socket?.destroy();bridge.stop();fs.rmSync(home,{recursive:true,force:true}) }
})
test('Ghostty only touches its owning terminal and confirms the exact UUID in the foreground', async () => {
  const {createGhostty}=require('../src/terminal/ghostty'),home=fs.mkdtempSync(path.join(os.tmpdir(),'allpet-ghostty-')),tty=path.join(home,'fixture-tty')
  fs.writeFileSync(tty,'');const id='00000000-0000-0000-0000-000000000001',other='00000000-0000-0000-0000-000000000002'
  let front=true, selected=other, writes=0
  const native={request:async op=>({bundleID:op==='owner'||front?'com.mitchellh.ghostty':'com.apple.Terminal'})}
  const command=async (_,args)=>{const s=args[1];if(s.includes('every terminal whose name'))return id;if(s.includes('then focus')){writes++;selected=id;return ''};return selected}
  const adapter=createGhostty(native,command),anchor={pid:99,tty,binding:{anchorStartedAtMicroseconds:1}}
  try {
    assert.equal(await adapter.operate(anchor,false),false)
    assert.equal(await adapter.operate(anchor,true),true);assert.equal(writes,1)
    front=false;assert.equal(await adapter.operate(anchor,false),false)
    assert.ok(fs.readFileSync(tty,'utf8').endsWith('\x1b[23;0t'))
  } finally { fs.rmSync(home,{recursive:true,force:true}) }
})
