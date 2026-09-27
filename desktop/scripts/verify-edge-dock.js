'use strict'
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), { spawnSync } = require('node:child_process')
const home = fs.realpathSync.native(fs.mkdtempSync(path.join(process.env.RUNNER_TEMP || os.tmpdir(), 'allpet-edge-')))
const output = path.resolve(process.env.ALLPET_EDGE_OUTPUT || path.join(os.tmpdir(), 'allpet-edge-result.json'))
const binary = process.env.ALLPET_APP_BINARY || require('electron')
fs.mkdirSync(path.dirname(output), { recursive: true })
try {
  for (const restoring of [false, true]) {
    const target = restoring ? output.replace(/\.json$/, '-restored.json') : output
    const args = process.env.ALLPET_APP_BINARY ? [] : [path.join(__dirname, '..')]
    args.push(`--user-data-dir=${path.join(home, 'electron')}`)
    if (process.env.ALLPET_NO_SANDBOX) args.push('--no-sandbox')
    const result = spawnSync(binary, args, { env: { ...process.env, ALLPET_HOME: home, ALLPET_EDGE_DOCK_SMOKE: target,
      ALLPET_EDGE_DOCK_RESTORE_SMOKE: restoring ? '1' : '' }, encoding: 'utf8', timeout: 60000, killSignal: 'SIGKILL' })
    if (result.status !== 0 || result.error) throw Error([result.error?.message, result.stdout, result.stderr, `exit ${result.status}`].filter(Boolean).join('\n'))
    const report = JSON.parse(fs.readFileSync(target, 'utf8'))
    if (!report.ok || (restoring && !report.restoredAfterRestart) || (!restoring && report.edges.length !== 4)) throw Error('edge dock verification failed')
    console.log(JSON.stringify(report))
  }
} finally { fs.rmSync(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }) }
