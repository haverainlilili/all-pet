'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { EventEmitter } = require('node:events');
const { compareVersions, detectTarget, selectAsset, checksumFromManifest, loadRelease, downloadVerified, replaceFile, windowsInstalled, installWindows, linuxPaths, linuxInstalled, installLinux, desktopEntry, main } = require('../install.cjs');

const digest = value => createHash('sha256').update(value).digest('hex');
async function temp(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'allpet-installer-test-'));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return dir;
}
const silent = () => {};

test('hardware architecture handles Rosetta and rejects Intel Mac / ARM Windows / WSL', async () => {
  const run = async (cmd, args) => ({ stdout: cmd.includes('sysctl') ? '1\n' : '14.7\n' });
  assert.deepEqual(await detectTarget({ platform: 'darwin', machine: 'x86_64', run }), { platform: 'darwin', arch: 'arm64' });
  await assert.rejects(detectTarget({ platform: 'darwin', machine: 'x86_64', run: async cmd => ({ stdout: cmd.includes('sysctl') ? '0' : '14.7' }) }), /Unsupported/);
  await assert.rejects(detectTarget({ platform: 'win32', machine: 'x86_64', env: { PROCESSOR_ARCHITEW6432: 'ARM64' } }), /Unsupported/);
  await assert.rejects(detectTarget({ platform: 'linux', machine: 'x86_64', release: 'microsoft-standard-WSL2' }), /WSL/);
  await assert.rejects(detectTarget({ platform: 'darwin', machine: 'arm64', run: async cmd => ({ stdout: cmd.includes('sysctl') ? '1' : '13.6' }) }), /macOS 14/);
  assert.equal((await detectTarget({ platform: 'win32', machine: 'AMD64', env: {} })).arch, 'x64');
  assert.equal((await detectTarget({ platform: 'linux', machine: 'x86_64', release: '6.8' })).arch, 'x64');
});

test('selects exact stable assets and keeps downloads in the official release', () => {
  const names = ['AllPet-1.5.0-arm64-mac.zip', 'AllPet-Setup-1.5.0.exe', 'AllPet-1.5.0.AppImage'];
  const release = { tag_name: 'v1.5.0', assets: names.map(name => ({ name, size: 100, browser_download_url: 'https://example.invalid/evil' })) };
  ['darwin', 'win32', 'linux'].forEach((platform, i) => {
    const asset = selectAsset(release, { platform });
    assert.equal(asset.name, names[i]);
    assert.equal(asset.url, `https://github.com/haverainlilili/all-pet/releases/download/v1.5.0/${names[i]}`);
  });
  assert.throws(() => selectAsset({ ...release, prerelease: true }, { platform: 'linux' }));
  assert.throws(() => selectAsset({ ...release, assets: [] }, { platform: 'linux' }));
  assert.throws(() => selectAsset({ ...release, tag_name: 'v1.5.0-beta.1' }, { platform: 'linux' }));
});

test('manifest requires the exact filename; stable comparison handles two-digit numbers', () => {
  const sha = 'a'.repeat(64);
  assert.equal(checksumFromManifest(`${sha}  AllPet.AppImage\r\n`, 'AllPet.AppImage'), sha);
  assert.equal(checksumFromManifest(`${sha} *AllPet.AppImage\n`, 'AllPet.AppImage'), sha);
  assert.throws(() => checksumFromManifest(`${sha}  wrong.AppImage`, 'AllPet.AppImage'));
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.5.0', '1.5.0'), 0);
  assert.equal(compareVersions('1.4.9', '1.5.0'), -1);
  assert.throws(() => compareVersions('1.5.0-beta', '1.5.0'));
});

test('API rate limits fall back to the pinned public stable release and exact checksum', async () => {
  const base = 'https://github.com/haverainlilili/all-pet/releases';
  const sha = 'a'.repeat(64), name = 'AllPet-1.5.0.AppImage';
  const fetcher = async (url, options) => {
    if (url.includes('api.github.com')) return new Response('rate limited', { status: 403 });
    if (url === `${base}/latest`) return { ok: true, url: `${base}/tag/v1.5.0` };
    if (url.endsWith('SHA256SUMS')) return new Response(`${sha}  ${name}\n`);
    assert.equal(url, `${base}/download/v1.5.0/${name}`);
    assert.equal(options.method, 'HEAD');
    return new Response(null, { headers: { 'content-length': '123' } });
  };
  const release = await loadRelease({ platform: 'linux' }, { fetcher, log: silent });
  assert.equal(selectAsset(release, { platform: 'linux' }).digest, `sha256:${sha}`);
  await assert.rejects(loadRelease({ platform: 'linux' }, { fetcher: async url => url.includes('api.github.com') ? new Response('', { status: 429 }) : { ok: true, url: 'https://example.invalid/tag/v1.5.0' }, log: silent }), /Invalid latest/);
  await assert.rejects(loadRelease({ platform: 'linux' }, { fetcher: async url => url.endsWith('SHA256SUMS') ? new Response(`${sha}  wrong-file`) : fetcher(url, { method: 'HEAD' }), log: silent }), /SHA256SUMS/);
});

test('streamed downloads verify bytes and remove partial, corrupt, oversized and HTTP failures', async t => {
  const dir = await temp(t), payload = 'signed release bytes';
  const asset = { name: 'test.zip', url: 'https://github.com/test', size: Buffer.byteLength(payload) };
  const file = path.join(dir, 'download.zip');
  const download = (body, checksum = digest(payload), status = 200) => downloadVerified(asset, checksum, file, { fetcher: async () => new Response(body, { status }), log: silent });
  await download(payload);
  assert.equal(await fs.readFile(file, 'utf8'), payload);
  await fs.rm(file);
  for (const data of ['short', 'signed release BYTES', payload + 'extra']) {
    await assert.rejects(download(data));
    await assert.rejects(fs.stat(file), { code: 'ENOENT' });
  }
  await assert.rejects(download('rate limited', digest(payload), 403), /403/);
});

test('failed replacement restores old file, successful replacement keeps backup until caller cleanup', async t => {
  const dir = await temp(t), destination = path.join(dir, 'app'), staged = path.join(dir, 'stage'), backup = path.join(dir, 'backup');
  await fs.writeFile(destination, 'old'); await fs.writeFile(staged, 'new');
  await assert.rejects(replaceFile(staged, destination, backup, async (a, b) => {
    if (a === staged) throw new Error('simulated disk failure');
    return fs.rename(a, b);
  }), /disk failure/);
  assert.equal(await fs.readFile(destination, 'utf8'), 'old');
  await replaceFile(staged, destination, backup);
  assert.equal(await fs.readFile(destination, 'utf8'), 'new');
  assert.equal(await fs.readFile(backup, 'utf8'), 'old');
});

test('double failure tells caller to retain recovery files', async t => {
  const dir = await temp(t), destination = path.join(dir, 'app'), staged = path.join(dir, 'stage'), backup = path.join(dir, 'backup');
  await fs.writeFile(destination, 'old'); await fs.writeFile(staged, 'new');
  await assert.rejects(replaceFile(staged, destination, backup, async (a, b) => {
    if (a !== destination) throw new Error('disk unavailable');
    return fs.rename(a, b);
  }), error => error.preserveBackup && error.message.includes(backup));
  assert.equal(await fs.readFile(backup, 'utf8'), 'old');
});

test('Windows reads the app ID uninstall key, detects missing exe and duplicate installs', async () => {
  const run = async (command, args) => {
    assert.equal(command, 'powershell.exe');
    assert.match(args.at(-1), /da04df8d-272a-5e14-a753-89a6afe9c592/);
    return { stdout: JSON.stringify([{ DisplayVersion: '1.5.0', DisplayIcon: 'C:\\Users\\Test User\\AllPet\\AllPet.exe,0' }]) };
  };
  assert.equal(await windowsInstalled(run, async file => file === 'C:\\Users\\Test User\\AllPet\\AllPet.exe'), '1.5.0');
  assert.equal(await windowsInstalled(run, async () => false), null);
  await assert.rejects(windowsInstalled(async () => ({ stdout: '[{},{}]' })), /多个/);
});

test('Windows invokes executable directly, reports cancel/failure and waits for exit', async () => {
  const file = 'C:\\Test User\\AllPet-Setup.exe';
  const spawnProcess = (exe, args, options) => {
    assert.equal(exe, file); assert.equal(options.shell, false); assert.deepEqual(args, []);
    const child = new EventEmitter(); process.nextTick(() => child.emit('exit', 0)); return child;
  };
  await installWindows(file, { spawnProcess });
  await assert.rejects(installWindows(file, { spawnProcess: () => {
    const child = new EventEmitter(); process.nextTick(() => child.emit('exit', 1)); return child;
  } }), /未完成/);
});

test('Linux installs and updates one executable, preserves profile and detects external modification', async t => {
  const home = path.join(await temp(t), process.platform === 'win32' ? 'Test 用户 Space' : 'Test 用户 $`%" Space');
  const paths = linuxPaths(home, {}), payload = path.join(await temp(t), 'release');
  const config = path.join(home, '.config', 'all-pet', 'pet.json');
  await fs.mkdir(path.dirname(config), { recursive: true }); await fs.writeFile(config, 'preserve me');
  await fs.writeFile(payload, 'version one');
  await installLinux(payload, '1.5.0', digest('version one'), { paths, log: silent });
  assert.equal(await linuxInstalled(paths), '1.5.0');
  await fs.writeFile(payload, 'version two');
  await installLinux(payload, '1.6.0', digest('version two'), { paths, log: silent });
  assert.equal(await linuxInstalled(paths), '1.6.0');
  assert.equal(await fs.readFile(config, 'utf8'), 'preserve me');
  assert.deepEqual((await fs.readdir(path.dirname(paths.app))).sort(), ['AllPet.AppImage', 'install.json']);
  assert.match(await fs.readFile(paths.desktop, 'utf8'), /Terminal=false/);
  assert.ok(desktopEntry('/home/Test 用户 $`%"/AllPet.AppImage').includes('%%'));
  if (process.platform !== 'win32') assert.ok((await fs.stat(paths.app)).mode & 0o111);
  await fs.appendFile(paths.app, 'modified');
  await assert.rejects(linuxInstalled(paths), /拒绝覆盖/);
});

test('Linux refuses existing unmanaged executable', async t => {
  const paths = linuxPaths(await temp(t), {});
  await fs.mkdir(path.dirname(paths.app), { recursive: true });
  await fs.writeFile(paths.app, 'not ours');
  await assert.rejects(linuxInstalled(paths), /拒绝覆盖/);
});

test('Linux menu write failure rolls back app and receipt together', async t => {
  const dir = await temp(t), paths = linuxPaths(path.join(dir, 'home'), {}), file = path.join(dir, 'release');
  await fs.writeFile(file, 'old');
  await installLinux(file, '1.5.0', digest('old'), { paths, log: silent });
  const originalMenu = await fs.readFile(paths.desktop, 'utf8');
  await fs.writeFile(file, 'new');
  await assert.rejects(installLinux(file, '1.6.0', digest('new'), { paths, log: silent, rename: async (source, destination) => {
    if (source.endsWith('allpet.desktop') && source !== paths.desktop) throw new Error('menu disk full');
    return fs.rename(source, destination);
  } }), /menu disk full/);
  assert.equal(await linuxInstalled(paths), '1.5.0');
  assert.equal(await fs.readFile(paths.desktop, 'utf8'), originalMenu);
});

test('Desktop Entry escapes strings before the Exec quoting layer', () => {
  const execLine = desktopEntry('/home/back\\slash/$cash/AllPet.AppImage').split('\n').find(line => line.startsWith('Exec='));
  assert.equal(execLine, String.raw`Exec="/home/back\\\\slash/\\$cash/AllPet.AppImage"`);
});

test('help makes no installation and unknown flags fail instead of unexpectedly installing', async () => {
  let output = '';
  await main(['--help'], { log: line => { output += line; } });
  assert.match(output, /npx --yes github:haverainlilili\/all-pet/);
  await assert.rejects(main(['-g']), /未知参数/);
});
