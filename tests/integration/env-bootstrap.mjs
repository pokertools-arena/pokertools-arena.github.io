import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const root = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const cwd = await mkdtemp(join(tmpdir(), 'pokertools-arena-env-'));
await writeFile(join(cwd, '.env'), [
  'OPENAI_BASE_URL=https://openrouter.ai/api/v1',
  'OPENAI_API_KEY="test-key-not-real"',
  'OPENAI_PLAYER1=google/gemma-4-26b-a4b-it',
  'OPENAI_PLAYER2=qwen/qwen3.8-flash',
  'OPENAI_PLAYER3=typesafe/jev-1.13',
  '',
].join('\n'));

const child = spawn(process.execPath, [join(root, 'bin', 'pokertools-arena.mjs'), '--port', '0', '--no-open'], {
  cwd,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let output = '';
const url = await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`Launcher timeout: ${output}`)), 8000);
  const onData = chunk => {
    output += String(chunk);
    const match = output.match(/pokertools-arena running at (http:\/\/[^\s]+)/);
    if (match) { clearTimeout(timer); resolve(match[1]); }
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.once('exit', code => { if (code && !output.includes('pokertools-arena running at')) { clearTimeout(timer); reject(new Error(`Launcher exited ${code}: ${output}`)); } });
});

try {
  const response = await fetch(new URL('arena-env.js', url));
  if (!response.ok) throw new Error(`arena-env.js returned ${response.status}`);
  const js = await response.text();
  const jsonText = js.match(/window\.__POKERTOOLS_ENV__ = (.*);/)?.[1];
  const config = JSON.parse(jsonText || 'null');
  if (config?.connections?.[0]?.baseUrl !== 'https://openrouter.ai/api/v1') throw new Error('Base URL was not loaded from .env');
  if (config?.connections?.[0]?.apiKey !== 'test-key-not-real') throw new Error('API key was not loaded from .env');
  if (config?.players?.length !== 3) throw new Error('Expected 3 players from .env');
  if (config.players[2].protocol !== 'jev_decisions') throw new Error('Jev .env player was not auto-routed to Decisions');
  console.log('env-bootstrap: PASS');
} finally {
  child.kill('SIGTERM');
  await rm(cwd, { recursive: true, force: true });
}
