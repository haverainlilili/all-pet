'use strict';

const fs = require('node:fs/promises');
const { createReadStream, createWriteStream, constants } = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { createHash } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { pipeline } = require('node:stream/promises');
const { execFile, spawn } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const REPO = 'haverainlilili/all-pet';
const APP_ID = 'com.haverainlilili.allpet';
const RELEASES = `https://github.com/${REPO}/releases`;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function exists(file) {
  try { await fs.lstat(file); return true; }
  catch (e) { if (e.code === 'ENOENT') return false; throw e; }
}

function versionParts(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error(`无效的稳定版本号 / Invalid stable version: ${version}`);
  return version.split('.').map(Number);
}

function compareVersions(a, b) {
  const left = versionParts(a), right = versionParts(b);
  for (let i = 0; i < 3; i++) if (left[i] !== right[i]) return Math.sign(left[i] - right[i]);
  return 0;
}

function normalizeArch(arch) {
  return { x64: 'x64', x86_64: 'x64', amd64: 'x64', arm64: 'arm64', aarch64: 'arm64' }[arch.toLowerCase()] || arch;
}

async function detectTarget({ platform = process.platform, machine = os.machine(), release = os.release(), env = process.env, run = exec } = {}) {
  let arch = normalizeArch(machine);
  if (platform === 'darwin') {
    // Detect the hardware, including an x64 Node running under Rosetta.
    try { if ((await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])).stdout.trim() === '1') arch = 'arm64'; } catch {}
    const systemVersion = (await run('/usr/bin/sw_vers', ['-productVersion'])).stdout.trim();
    if (Number(systemVersion.split('.')[0]) < 14) throw new Error('AllPet 需要 macOS 14 或更新版本 / macOS 14+ required.');
  }
  if (platform === 'win32') arch = normalizeArch(env.PROCESSOR_ARCHITEW6432 || env.PROCESSOR_ARCHITECTURE || machine);
  if (platform === 'linux' && /microsoft/i.test(release)) throw new Error('WSL 请在 Windows PowerShell / CMD 中执行安装命令，以安装 Windows 桌宠。');
  const supported = (platform === 'darwin' && arch === 'arm64') || (['win32', 'linux'].includes(platform) && arch === 'x64');
  if (!supported) throw new Error(`暂无此系统的安装包 / Unsupported platform: ${platform} ${arch}. 支持 macOS arm64、Windows x64、Linux x64。`);
  return { platform, arch };
}

function selectAsset(release, target) {
  if (release.draft || release.prerelease || !/^v\d+\.\d+\.\d+$/.test(release.tag_name)) {
    throw new Error('GitHub 未返回有效的正式版 / Not a stable release.');
  }
  const version = release.tag_name.slice(1);
  versionParts(version);
  const names = { darwin: `AllPet-${version}-arm64-mac.zip`, win32: `AllPet-Setup-${version}.exe`, linux: `AllPet-${version}.AppImage` };
  const asset = release.assets?.find(item => item.name === names[target.platform]);
  if (!asset || !Number.isSafeInteger(asset.size) || asset.size <= 0 || asset.size > 1024 ** 3) {
    throw new Error(`正式版缺少有效的 ${target.platform} 安装包 / Missing release asset.`);
  }
  // Build the URL ourselves: release metadata cannot redirect the initial request to another repository.
  return { ...asset, version, url: `${RELEASES}/download/${release.tag_name}/${asset.name}` };
}

async function getResponse(url, { fetcher = fetch, timeout = 30000 } = {}) {
  const response = await fetcher(url, {
    headers: { 'User-Agent': 'AllPet-Installer/1.0', Accept: new URL(url).hostname === 'api.github.com' ? 'application/vnd.github+json' : 'application/octet-stream' },
    signal: AbortSignal.timeout(timeout)
  });
  if (!response.ok) throw new Error(`下载失败 / HTTP ${response.status}: ${url}${response.status === 403 || response.status === 429 ? '（可能触发 GitHub 限流，请稍后重试）' : ''}`);
  return response;
}

async function loadRelease() {
  return (await getResponse(`https://api.github.com/repos/${REPO}/releases/latest`)).json();
}

function checksumFromManifest(manifest, name) {
  const line = manifest.split(/\r?\n/).map(row => row.match(/^([a-f\d]{64})\s+\*?(.+)$/i)).find(match => match?.[2] === name);
  if (!line) throw new Error(`SHA256SUMS 缺少 ${name}，已停止安装。`);
  return line[1].toLowerCase();
}

async function expectedChecksum(release, asset) {
  if (/^sha256:[a-f\d]{64}$/i.test(asset.digest || '')) return asset.digest.slice(7).toLowerCase();
  if (!release.assets?.some(item => item.name === 'SHA256SUMS')) throw new Error('发布包没有 SHA-256 校验信息，已停止安装。');
  const response = await getResponse(`${RELEASES}/download/${release.tag_name}/SHA256SUMS`);
  return checksumFromManifest(await response.text(), asset.name);
}

async function hashFile(file) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function downloadVerified(asset, checksum, destination, { fetcher = fetch, log = console.log } = {}) {
  const response = await getResponse(asset.url, { fetcher, timeout: 20 * 60 * 1000 });
  let size = 0, lastStep = 0;
  const hash = createHash('sha256');
  const meter = new Transform({ transform(chunk, encoding, callback) {
    size += chunk.length;
    if (size > asset.size) return callback(new Error('下载大小超出发布记录，已停止 / Download larger than release asset.'));
    hash.update(chunk);
    const step = Math.floor(size / asset.size * 10);
    if (step > lastStep) { lastStep = step; log(`下载 / Download: ${step * 10}%`); }
    callback(null, chunk);
  } });
  try {
    await pipeline(Readable.fromWeb(response.body), meter, createWriteStream(destination, { flags: 'wx', mode: 0o600 }));
    if (size !== asset.size || hash.digest('hex') !== checksum) throw new Error('安装包 SHA-256 / 大小校验失败，原安装未修改 / Integrity check failed.');
  } catch (e) {
    await fs.rm(destination, { force: true });
    throw e;
  }
}

async function readMacVersion(app, run = exec) {
  if (!(await exists(app))) return null;
  if ((await fs.lstat(app)).isSymbolicLink()) throw new Error(`${app} 是符号链接，请手动安装。`);
  const plist = path.join(app, 'Contents', 'Info.plist');
  const read = async key => (await run('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist])).stdout.trim();
  if (await read('CFBundleIdentifier') !== APP_ID) throw new Error(`目标不是 AllPet，拒绝覆盖 / Refusing to replace: ${app}`);
  return read('CFBundleShortVersionString');
}

async function macPids(app, run = exec) {
  const executable = path.join(app, 'Contents', 'MacOS', 'AllPet');
  const { stdout } = await run('/bin/ps', ['-axo', 'pid=,comm=']);
  return stdout.split('\n').map(line => line.trim().match(/^(\d+)\s+(.+)$/)).filter(m => m?.[2] === executable).map(m => Number(m[1]));
}

async function stopMac(app, run = exec) {
  const pids = await macPids(app, run);
  if (!pids.length) return;
  // Send the normal app quit event so Electron can save state and stop its Swift sidecars.
  // Passing the path as an argument avoids interpolating it into AppleScript source.
  try {
    await run('/usr/bin/osascript', ['-e', 'on run argv', '-e', 'tell application (item 1 of argv) to quit', '-e', 'end run', app], { timeout: 15000 });
  } catch {
    throw new Error('无法正常退出 AllPet，请从菜单退出后重试；旧版本尚未替换。');
  }
  for (let i = 0; i < 40; i++) {
    if (!(await macPids(app, run)).length) return;
    await sleep(250);
  }
  throw new Error('AllPet 尚未退出，请从菜单退出后重试；旧版本尚未替换。');
}

// Keep the previous app until the staged replacement succeeds, including a rollback on rename failure.
async function replaceFile(staged, destination, backup, rename = fs.rename) {
  const hadPrevious = await exists(destination);
  if (hadPrevious) await rename(destination, backup);
  try { await rename(staged, destination); }
  catch (error) {
    if (hadPrevious) {
      try { await rename(backup, destination); }
      catch (rollbackError) {
        const failure = new Error(`替换及回滚失败；旧文件保留在 ${backup}。${rollbackError.message}`);
        failure.preserveBackup = true;
        throw failure;
      }
    }
    throw error;
  }
}

async function installMac(archive, version, { destination = '/Applications/AllPet.app', launch = true, run = exec, stop = stopMac, log = console.log } = {}) {
  const parent = path.dirname(destination);
  await fs.access(parent, constants.W_OK);
  await readMacVersion(destination, run); // Refuse an unrelated existing application.
  const staging = await fs.mkdtemp(path.join(parent, '.allpet-install-'));
  let preserve = false;
  try {
    const unpacked = path.join(staging, 'unpacked');
    await fs.mkdir(unpacked);
    await run('/usr/bin/ditto', ['-x', '-k', archive, unpacked]);
    const app = path.join(unpacked, 'AllPet.app');
    if (await readMacVersion(app, run) !== version) throw new Error('解包后的应用版本不匹配 / Bundle version mismatch.');
    await run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    await stop(destination, run);
    await replaceFile(app, destination, path.join(staging, 'previous.app'));
    log(`已安装 / Installed: ${destination} (${version})`);
  } catch (e) { preserve = e.preserveBackup === true; throw e; }
  finally { if (!preserve) await fs.rm(staging, { recursive: true, force: true }); }
  if (launch) {
    try { await run('/usr/bin/open', [destination]); }
    catch { log('安装完成；请从“应用程序”打开 AllPet，按 macOS 安全提示操作。'); }
  }
  log('macOS 辅助功能等权限需在系统设置中确认；安装器不修改系统安全设置。');
}

const WINDOWS_QUERY = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$key = 'Software\Microsoft\Windows\CurrentVersion\Uninstall\da04df8d-272a-5e14-a753-89a6afe9c592'
$roots = @("HKCU:\$key", "HKLM:\$key", 'HKLM:\Software\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\da04df8d-272a-5e14-a753-89a6afe9c592')
$apps = @(Get-ItemProperty $roots -ErrorAction SilentlyContinue | Select-Object DisplayVersion, DisplayIcon)
ConvertTo-Json -InputObject $apps -Compress
`;

async function windowsInstalled(run = exec, fileExists = exists) {
  const { stdout } = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', WINDOWS_QUERY]);
  const entries = JSON.parse(stdout.replace(/^\uFEFF/, '').trim() || '[]');
  if (entries.length > 1) throw new Error('检测到多个 Windows AllPet 安装，请先通过系统“已安装的应用”保留一个安装位置。');
  const app = entries[0];
  const executable = app?.DisplayIcon?.replace(/,\d+$/, '').replace(/^"|"$/g, '');
  return executable && await fileExists(executable) ? app.DisplayVersion : null;
}

async function installWindows(file, { args = [], spawnProcess = spawn } = {}) {
  await new Promise((resolve, reject) => {
    // No shell interpolation, no forced silent/elevated install. NSIS handles its existing install location.
    const child = spawnProcess(file, args, { stdio: 'inherit', shell: false });
    child.on('error', reject);
    child.on('exit', (code, signal) => code === 0 ? resolve() : reject(new Error(`Windows 安装器未完成（${signal || code}）；请检查取消或系统提示。`)));
  });
}

function linuxPaths(home = os.homedir(), env = process.env) {
  return {
    app: path.join(home, '.local', 'opt', 'allpet', 'AllPet.AppImage'),
    receipt: path.join(home, '.local', 'opt', 'allpet', 'install.json'),
    desktop: path.join(path.isAbsolute(env.XDG_DATA_HOME || '') ? env.XDG_DATA_HOME : path.join(home, '.local', 'share'), 'applications', 'allpet.desktop')
  };
}

async function linuxInstalled(paths) {
  if (!(await exists(paths.app))) return null;
  if ((await fs.lstat(paths.app)).isSymbolicLink()) throw new Error('AllPet.AppImage 是符号链接，请手动安装。');
  let receipt;
  try { receipt = JSON.parse(await fs.readFile(paths.receipt, 'utf8')); } catch {}
  if (receipt?.installer !== 'allpet-installer' || !/^[a-f\d]{64}$/.test(receipt.sha256 || '') || await hashFile(paths.app) !== receipt.sha256) {
    throw new Error(`已有文件不是此安装器管理的有效 AllPet，拒绝覆盖：${paths.app}`);
  }
  return receipt.version;
}

function desktopEntry(app) {
  // Exec quoting is decoded after Desktop Entry string escapes (two distinct layers).
  const quoted = app.replace(/[\\"`$]/g, '\\$&').replace(/\\/g, '\\\\').replace(/%/g, '%%');
  return `[Desktop Entry]\nType=Application\nName=AllPet\nComment=AI coding agent desktop pet\nExec="${quoted}"\nIcon=applications-games\nTerminal=false\nCategories=Utility;\n`;
}

async function installLinux(file, version, checksum, { paths = linuxPaths(), log = console.log, rename = fs.rename } = {}) {
  await linuxInstalled(paths);
  if (/[\x00-\x1f=]/.test(paths.app)) throw new Error('安装路径包含桌面入口不支持的控制字符或等号。');
  if (await exists(paths.desktop) && !(await exists(paths.receipt))) throw new Error(`已有桌面入口，拒绝覆盖：${paths.desktop}`);
  await fs.mkdir(path.dirname(paths.app), { recursive: true });
  await fs.mkdir(path.dirname(paths.desktop), { recursive: true });
  const staging = await fs.mkdtemp(path.join(path.dirname(paths.app), '.install-'));
  let preserve = false, menuStaging;
  const completed = [];
  try {
    menuStaging = await fs.mkdtemp(path.join(path.dirname(paths.desktop), '.allpet-menu-'));
    const staged = path.join(staging, 'AllPet.AppImage');
    await fs.copyFile(file, staged);
    await fs.chmod(staged, 0o755);
    await fs.writeFile(path.join(staging, 'install.json'), JSON.stringify({ installer: 'allpet-installer', version, sha256: checksum }, null, 2) + '\n');
    await fs.writeFile(path.join(menuStaging, 'allpet.desktop'), desktopEntry(paths.app));
    // Each stage/backup is on the target filesystem, even with a separate XDG_DATA_HOME mount.
    const entries = [
      [staged, paths.app, path.join(staging, 'previous.AppImage')],
      [path.join(staging, 'install.json'), paths.receipt, path.join(staging, 'previous.json')],
      [path.join(menuStaging, 'allpet.desktop'), paths.desktop, path.join(menuStaging, 'previous.desktop')]
    ];
    for (const [source, destination, backup] of entries) {
      const hadPrevious = await exists(destination);
      await replaceFile(source, destination, backup, rename);
      completed.push({ destination, backup, hadPrevious });
    }
  } catch (e) {
    preserve = e.preserveBackup === true;
    for (const entry of completed.reverse()) {
      try {
        await fs.rm(entry.destination, { force: true });
        if (entry.hadPrevious) await rename(entry.backup, entry.destination);
      } catch { preserve = true; }
    }
    if (preserve) throw new Error(`Linux 更新未完成；恢复文件保留在 ${staging} 和 ${menuStaging}。${e.message}`);
    throw e;
  } finally {
    if (!preserve) {
      await fs.rm(staging, { recursive: true, force: true });
      if (menuStaging) await fs.rm(menuStaging, { recursive: true, force: true });
    }
  }
  log(`已安装 / Installed: ${paths.app} (${version})\n在应用菜单打开 AllPet；已运行的旧进程请退出后重新打开。\nAppImage 需要桌面环境与 FUSE 支持；不支持时可手动安装 Release 中的 DEB。`);
}

async function main(args, { log = console.log } = {}) {
  if (args.some(arg => !['--help', '-h', '--dry-run'].includes(arg))) throw new Error('未知参数。使用 --help 查看用法；无需 -g。');
  if (args.includes('--help') || args.includes('-h')) {
    log(`AllPet 一行安装 / One-command installer\n\nnpx --yes github:${REPO}\n\n--dry-run  仅查看最新版本和安装目标，不下载安装包或修改应用\n--help     显示帮助\n\n需要 Node.js 24.18+、npm 11.16+ 和 Git；无需 Swift，无需 -g。\n重复执行更新正式版；macOS/Linux 相同或更高版本跳过，Windows 按注册表版本判断。\n支持 macOS 14+ Apple Silicon、Windows x64、Linux x64（WSL 请在 Windows 中运行）。\n${RELEASES}/latest`);
    return;
  }
  if (compareVersions(process.versions.node.split('-')[0], '24.18.0') < 0) throw new Error('请使用 Node.js 24.18+（含 npm 11.16+）或更新版本。');
  const target = await detectTarget();
  log(`检查正式版 / Checking stable release (${target.platform} ${target.arch})…`);
  const release = await loadRelease();
  const asset = selectAsset(release, target);
  const checksum = await expectedChecksum(release, asset);
  log(`最新版 / Latest: ${asset.version}\n安装包 / Asset: ${asset.name}\nSHA-256: ${checksum}`);
  if (args.includes('--dry-run')) {
    log(`目标 / Target: ${target.platform === 'darwin' ? '/Applications/AllPet.app' : target.platform === 'win32' ? '官方 Windows NSIS 安装器（沿用其安装位置）' : linuxPaths().app}\n仅预览 / Dry run — no app changes.`);
    return;
  }
  const installed = target.platform === 'darwin' ? await readMacVersion('/Applications/AllPet.app') : target.platform === 'win32' ? await windowsInstalled() : await linuxInstalled(linuxPaths());
  if (installed && compareVersions(installed, asset.version) >= 0) {
    log(`已安装 ${installed}，无需更新 / Already current; no changes.`);
    return;
  }
  if (target.platform === 'darwin') await fs.access('/Applications', constants.W_OK);
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'allpet-installer-'));
  try {
    const file = path.join(temporary, asset.name);
    log(`下载 / Download: ${asset.url}`);
    await downloadVerified(asset, checksum, file, { log });
    log('校验通过 / SHA-256 verified.');
    if (target.platform === 'darwin') await installMac(file, asset.version, { log });
    else if (target.platform === 'win32') {
      log('正在运行官方 Windows 安装器，请完成系统提示 / Running Windows installer…');
      await installWindows(file);
      const actual = await windowsInstalled();
      if (actual !== asset.version) throw new Error('安装器已退出，但未确认目标版本；请查看系统安装提示后重试。');
      log(`已安装 / Installed: AllPet ${actual}`);
    } else await installLinux(file, asset.version, checksum, { log });
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

module.exports = { compareVersions, detectTarget, selectAsset, checksumFromManifest, loadRelease, expectedChecksum, downloadVerified, hashFile, readMacVersion, replaceFile, installMac, windowsInstalled, installWindows, linuxPaths, linuxInstalled, desktopEntry, installLinux, main };
