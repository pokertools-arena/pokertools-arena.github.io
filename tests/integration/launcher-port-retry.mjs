// Launcher port-retry regression test (offline).
//
// When the requested port is busy the launcher retries the next port. A bug in
// that retry (calling listen() again on the same Server from its EADDRINUSE
// handler) made Node emit 'listening' twice, printing the startup banner twice
// and opening two browser windows. This test occupies a port and asserts the
// launcher starts exactly once on a different port.
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));

const blocker = createServer((req, res) => res.end('busy'));
await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
const busyPort = blocker.address().port;

const child = spawn(process.execPath, [join(root, 'bin', 'pokertools-arena.mjs'), '--port', String(busyPort), '--no-open', '--no-env'], {
  cwd: root,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
child.stdout.on('data', chunk => { output += String(chunk); });
child.stderr.on('data', chunk => { output += String(chunk); });

try {
  const port = await new Promise((resolve, reject) => {
    const deadline = Date.now() + 8000;
    const poll = setInterval(() => {
      const match = output.match(/pokertools-arena running at http:\/\/127\.0\.0\.1:(\d+)\//);
      if (match) { clearInterval(poll); resolve(Number(match[1])); }
      else if (Date.now() > deadline) { clearInterval(poll); reject(new Error(`Launcher timeout: ${output}`)); }
    }, 50);
  });
  if (port === busyPort) throw new Error(`Launcher stayed on the busy port ${busyPort}`);
  // Allow any erroneous duplicate startup to print its banner.
  await new Promise(resolve => setTimeout(resolve, 1200));
  const bannerCount = (output.match(/pokertools-arena running at /g) || []).length;
  if (bannerCount !== 1) throw new Error(`Expected exactly one startup banner, saw ${bannerCount}:\n${output}`);
  console.log('launcher-port-retry: PASS');
} finally {
  child.kill('SIGTERM');
  await new Promise(resolve => blocker.close(resolve));
}
