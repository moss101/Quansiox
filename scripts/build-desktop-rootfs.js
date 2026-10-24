#!/usr/bin/env node
'use strict';
// Installs the guest desktop with Alpine's signed package manager inside an
// actual ARM64 VM. The host never executes downloaded Linux binaries.
const fs = require('node:fs'), path = require('node:path'), { spawn } = require('node:child_process');
const vmDir = path.resolve(__dirname, '../vm');
if (!fs.existsSync(path.join(vmDir, 'desktop-rootfs/sbin/apk'))) throw new Error('Verified Alpine desktop-rootfs seed is missing');
const proc = spawn(path.join(vmDir, 'qx-vm'), ['--kernel', path.join(vmDir, 'Image'), '--initrd', path.join(vmDir, 'initramfs.cpio.gz'), '--share', vmDir, '--mem', '4096'], { stdio: ['pipe', 'pipe', 'pipe'] });
let buffer = '', ready = false, counter = 0;
const pending = new Map();
const timeout = setTimeout(() => { console.error('Guest desktop build timed out'); proc.kill('SIGKILL'); process.exitCode = 1; }, 10 * 60_000);
proc.stderr.on('data', (data) => process.stderr.write(data));
proc.stdout.on('data', (data) => {
  buffer += data.toString();
  let newline;
  while ((newline = buffer.indexOf('\n')) !== -1) {
    const line = buffer.slice(0, newline).replace(/\r$/, ''); buffer = buffer.slice(newline + 1);
    if (!ready && line.includes('QX_VM_READY')) { ready = true; install().catch(fail); }
    const fields = line.split('\t');
    if (fields[0] === 'RES' && pending.has(fields[1])) { pending.get(fields[1])({ exitCode: Number(fields[2]), output: Buffer.from(fields[3] || '', 'base64').toString() }); pending.delete(fields[1]); }
  }
});
function command(command) {
  const id = `build${++counter}`;
  return new Promise((resolve) => { pending.set(id, resolve); proc.stdin.write(`EXEC\t${id}\t${Buffer.from(command).toString('base64')}\n`); });
}
function fail(error) { console.error(error); process.exitCode = 1; clearTimeout(timeout); proc.kill('SIGTERM'); }
async function install() {
  console.log('Guest ready; configuring build networking');
  const network = await command('modprobe virtio_net; ip link set eth0 up; udhcpc -i eth0 -s /usr/share/udhcpc/default.script -n -q -t 5');
  console.log(network.output);
  if (network.exitCode) throw new Error('Guest DHCP failed');
  const setup = await command('cp /etc/resolv.conf /share/desktop-rootfs/etc/resolv.conf; mkdir -p /share/desktop-rootfs/proc /share/desktop-rootfs/sys /share/desktop-rootfs/dev; mount -t proc proc /share/desktop-rootfs/proc; mount -t sysfs sysfs /share/desktop-rootfs/sys; mount -t devtmpfs devtmpfs /share/desktop-rootfs/dev');
  console.log(setup.output);
  console.log('Installing signed Chromium, X11, VNC and guest tools…');
  const result = await command('chroot /share/desktop-rootfs /sbin/apk add --no-cache chromium xvfb openbox x11vnc xterm socat xdotool imagemagick font-dejavu dbus ca-certificates linux-virt xwd > /share/desktop-build.log 2>&1; rc=$?; umount /share/desktop-rootfs/proc /share/desktop-rootfs/sys /share/desktop-rootfs/dev; echo "$rc" > /share/desktop-build.exit; exit "$rc"');
  if (result.exitCode) throw new Error(`Guest package install failed: ${result.output}. See vm/desktop-build.log`);
  console.log('Guest desktop packages installed successfully');
  fs.writeFileSync(path.join(vmDir, 'desktop-build.json'), JSON.stringify({ alpine: '3.24.2', installedAt: new Date().toISOString(), packages: ['chromium', 'xvfb', 'openbox', 'x11vnc', 'xterm', 'socat', 'xdotool', 'imagemagick', 'font-dejavu', 'dbus', 'ca-certificates', 'linux-virt', 'xwd'] }, null, 2));
  clearTimeout(timeout); proc.kill('SIGTERM');
}
proc.on('exit', () => { clearTimeout(timeout); });
