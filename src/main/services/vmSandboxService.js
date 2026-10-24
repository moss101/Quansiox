'use strict';
/**
 * VM sandbox adapter — runs a session's sandbox inside a real Linux VM
 * (Alpine linux-virt) via Virtualization.framework (vm/qx-vm). Speaks the
 * VM agent's TSV protocol (op\tid\targs -> RES\tid\texit\tb64) and adapts
 * it to the sandboxService JSON-RPC method surface.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const VM_DIR = path.join(__dirname, '..', '..', '..', 'vm');
const QX_VM = path.join(VM_DIR, 'qx-vm');

const b64 = (s) => Buffer.from(String(s), 'utf8').toString('base64');
const unb64 = (s) => Buffer.from(String(s ?? ''), 'base64').toString('utf8');

/** sessionId -> { proc, pending: Map, ready, buffer, startedAt } */
const vms = new Map();

function available() {
  return ['qx-vm', 'Image', 'initramfs.cpio.gz'].every((name) => fs.existsSync(path.join(VM_DIR, name)));
}

/** Boot a VM for the session; resolves when the guest agent is ready. */
function ensureVm(sessionId, shareDir) {
  const existing = vms.get(sessionId);
  if (existing && existing.ready && existing.proc.exitCode === null) return Promise.resolve(existing);
  if (existing?.readyPromise && existing.proc?.exitCode === null) return existing.readyPromise;

  fs.mkdirSync(shareDir, { recursive: true });
  const entry = { proc: null, pending: new Map(), ready: false, buffer: '', startedAt: Date.now(), nextId: 1 };
  vms.set(sessionId, entry);

  entry.readyPromise = new Promise((resolve, reject) => {
    entry.proc = spawn(QX_VM, [
      '--kernel', path.join(VM_DIR, 'Image'),
      '--initrd', path.join(VM_DIR, 'initramfs.cpio.gz'),
      '--share', shareDir,
    ], { stdio: ['pipe', 'pipe', 'pipe'] });

    const timeout = setTimeout(() => {
      if (!entry.ready) {
        reject(new Error('VM sandbox failed to become ready (VZ unavailable?)'));
        entry.proc.kill('SIGKILL');
        vms.delete(sessionId);
      }
    }, 60_000);

    entry.proc.stdout.on('data', (chunk) => {
      entry.buffer += chunk.toString();
      let nl;
      while ((nl = entry.buffer.indexOf('\n')) !== -1) {
        // An empty payload is a trailing tab; trimming it drops the fourth
        // field and leaves otherwise successful commands waiting forever.
        const line = entry.buffer.slice(0, nl).replace(/\r$/, '');
        entry.buffer = entry.buffer.slice(nl + 1);
        if (!line) continue;
        if (!entry.ready && line.includes('QX_VM_READY')) {
          entry.ready = true;
          clearTimeout(timeout);
          resolve(entry);
          continue;
        }
        const parts = line.split('\t');
        if (parts[0] !== 'RES' || parts.length < 4) continue; // kernel noise
        const waiter = entry.pending.get(parts[1]);
        if (waiter) {
          entry.pending.delete(parts[1]);
          waiter({ exitCode: Number(parts[2]) || 0, output: unb64(parts[3]) });
        }
      }
    });
    entry.proc.stderr.on('data', (d) => console.error('[vm-sandbox]', d.toString().trim().slice(0, 200)));
    entry.proc.on('error', (error) => {
      clearTimeout(timeout);
      if (vms.get(sessionId) === entry) vms.delete(sessionId);
      reject(error);
    });
    entry.proc.on('exit', () => {
      clearTimeout(timeout);
      if (!entry.ready) reject(new Error('VM exited before becoming ready'));
      for (const w of entry.pending.values()) w({ exitCode: -1, output: 'VM exited' });
      entry.pending.clear();
      if (vms.get(sessionId) === entry) vms.delete(sessionId);
    });
  });
  return entry.readyPromise;
}

/** Call a method on the session VM. Methods mirror the process sandbox. */
async function callVm(sessionId, method, params) {
  const entry = vms.get(sessionId);
  if (!entry || !entry.ready) throw new Error('VM sandbox not ready');
  const id = `v${entry.nextId++}`;
  if (method.startsWith('fs.')) {
    const p = String(params.p ?? '.');
    if (/[\t\r\n]/.test(p) || path.posix.isAbsolute(p) || p.split('/').includes('..')) {
      throw new Error('invalid VM file path');
    }
  }
  let op, b64arg;
  switch (method) {
    case 'exec':
      op = 'EXEC'; b64arg = b64(params.command);
      break;
    case 'fs.read':
      op = 'FSREAD'; b64arg = params.p;
      break;
    case 'fs.write':
      op = 'FSWRITE'; b64arg = `${params.p}\t${b64(params.content)}`;
      break;
    case 'fs.listdir':
      op = 'LIST'; b64arg = params.p ?? '.';
      break;
    case 'ping':
      op = 'PING'; b64arg = '';
      break;
    default:
      throw new Error(`VM sandbox does not support ${method}`);
  }
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error(`VM ${op} timed out`));
    }, 120_000);
    entry.pending.set(id, (v) => { clearTimeout(timer); resolve(v); });
    entry.proc.stdin.write(`${op}\t${id}${b64arg ? `\t${b64arg}` : ''}\n`);
  });
  // Preserve the same contracts consumed by coordinator file tools in process mode.
  if (method.startsWith('fs.') && result.exitCode !== 0) throw new Error(result.output || `VM ${op} failed`);
  if (method === 'fs.read') return result.output;
  if (method === 'fs.write') return { bytes: Buffer.byteLength(String(params.content), 'utf8') };
  if (method === 'fs.listdir') return result.output.split('\n').filter(Boolean).map((name) => ({
    name: name.endsWith('/') ? name.slice(0, -1) : name,
    dir: name.endsWith('/'),
  }));
  return result;
}

function stopVm(sessionId) {
  const entry = vms.get(sessionId);
  if (entry) {
    try { entry.proc.kill('SIGTERM'); } catch {}
    vms.delete(sessionId);
  }
  return true;
}

function status() {
  return [...vms.entries()].map(([id, e]) => ({
    sessionId: id,
    kind: 'linux-vm',
    ready: e.ready,
    pid: e.proc?.pid ?? null,
    uptimeMs: Date.now() - e.startedAt,
  }));
}

module.exports = { vmSandbox: { available, ensureVm, callVm, stopVm, status } };
