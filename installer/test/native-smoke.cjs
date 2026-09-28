'use strict';
// Runs only on disposable CI machines. Never invokes the user's installed AllPet.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { promisify } = require('node:util');
const exec = promisify(require('node:child_process').execFile);
const { loadRelease, detectTarget, selectAsset, expectedChecksum, downloadVerified, installMac, readMacVersion, installWindows, windowsInstalled, installLinux, linuxPaths, linuxInstalled } = require('../install.cjs');

async function smoke() {
  if (process.env.GITHUB_ACTIONS !== 'true') throw new Error('Native installation smoke runs on disposable GitHub Actions machines only.');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'allpet-installer-smoke-'));
  try {
    const target = await detectTarget(), release = await loadRelease();
    const asset = selectAsset(release, target), checksum = await expectedChecksum(release, asset);
    const file = path.join(dir, asset.name);
    await downloadVerified(asset, checksum, file);
    if (target.platform === 'darwin') {
      const destination = path.join(dir, 'AllPet.app');
      await installMac(file, asset.version, { destination, launch: false });
      assert.equal(await readMacVersion(destination), asset.version);
      // Exercise replacement, including removal of the temporary previous app.
      await installMac(file, asset.version, { destination, launch: false });
      assert.equal((await fs.readdir(dir)).filter(name => name.endsWith('.app')).length, 1);
      assert.equal((await fs.readdir(dir)).filter(name => name.startsWith('.allpet-')).length, 0);
    } else if (target.platform === 'win32') {
      assert.equal(await windowsInstalled(), null, 'CI must start without an existing AllPet installation');
      const destination = path.join(dir, 'installed');
      await installWindows(file, { args: ['/S', '/currentuser', `/D=${destination}`] });
      assert.equal(await windowsInstalled(), asset.version);
      await fs.access(path.join(destination, 'AllPet.exe'));
      await installWindows(file, { args: ['/S', '/currentuser'] });
      assert.equal(await windowsInstalled(), asset.version);
      await fs.access(path.join(destination, 'AllPet.exe'));
      // NSIS owns registry/shortcut cleanup as well as installation.
      await installWindows(path.join(destination, 'Uninstall AllPet.exe'), { args: ['/S', '/currentuser'] });
    } else {
      const paths = linuxPaths(path.join(dir, 'home 用户 $cash'), {});
      await installLinux(file, asset.version, checksum, { paths });
      assert.equal(await linuxInstalled(paths), asset.version);
      await installLinux(file, asset.version, checksum, { paths });
      const { stdout } = await exec(paths.app, ['--appimage-version']);
      assert.match(stdout, /AppImage/i);
      await exec('desktop-file-validate', [paths.desktop]);
      assert.deepEqual((await fs.readdir(path.dirname(paths.app))).sort(), ['AllPet.AppImage', 'install.json']);
    }
    console.log(`Native install and repeat install passed: ${target.platform} ${asset.version}`);
  } finally { await fs.rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 }); }
}
smoke().catch(error => { console.error(error); process.exitCode = 1; });
