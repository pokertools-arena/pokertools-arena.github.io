#!/usr/bin/env node
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, dirname, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const root = join(packageRoot, 'dist');
const args = process.argv.slice(2);
const valueAfter = (flag, fallback) => {
  const index = args.indexOf(flag);
  return index >= 0 && args[index + 1] ? args[index + 1] : fallback;
};
const host = valueAfter('--host', '127.0.0.1');
const requestedPortRaw = valueAfter('--port', '4173');
const requestedPort = requestedPortRaw === '0' ? 0 : (Number(requestedPortRaw) || 4173);
const shouldOpen = !args.includes('--no-open');
const help = args.includes('--help') || args.includes('-h');
const useEnv = !args.includes('--no-env');
const useChrome = args.includes('--chrome');
const envOverrides = {
  OPENAI_STARTING_STACK: valueAfter('--starting-stack', null),
  OPENAI_MAX_DECISIONS: valueAfter('--max-decisions', null),
  OPENAI_AUTOSTART: args.includes('--autostart') ? '1' : null,
};

function parseDotEnv(text) {
  const out = {};
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    if (line.startsWith('export ')) line = line.slice(7).trim();
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\n/g, '\n').replace(/\r/g, '\r').replace(/\t/g, '\t').replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    } else {
      value = value.replace(/\s+#.*$/, '').trim();
    }
    out[key] = value;
  }
  return out;
}

async function loadArenaEnv() {
  if (!useEnv) return { source: null, values: {} };
  const candidates = [resolve(process.cwd(), '.env'), join(packageRoot, '.env')];
  for (const candidate of [...new Set(candidates)]) {
    try {
      const values = parseDotEnv(await readFile(candidate, 'utf8'));
      return { source: candidate, values };
    } catch {}
  }
  return { source: null, values: {} };
}

function envBootstrap(values, overrides = {}) {
  const baseUrl = String(values.OPENAI_BASE_URL || process.env.OPENAI_BASE_URL || '').trim();
  const apiKey = String(values.OPENAI_API_KEY || process.env.OPENAI_API_KEY || '').trim();
  const models = [];
  for (let i = 1; i <= 10; i++) {
    const model = String(values[`OPENAI_PLAYER${i}`] || process.env[`OPENAI_PLAYER${i}`] || '').trim();
    if (model) models.push({ index: i, model });
  }
  if (!baseUrl && !apiKey && !models.length) return null;
  const resolvedBase = baseUrl || 'https://api.openai.com/v1';
  const isOpenRouter = /(^|\.)openrouter\.ai(?=\/|$)/i.test(new URL(resolvedBase).hostname);
  const connectionId = 'env-connection';
  const truthy = value => /^(1|true|yes|on)$/i.test(String(value ?? '').trim());
  const flagOrEnv = flag => {
    if (overrides[flag] !== undefined && overrides[flag] !== null && overrides[flag] !== '') return overrides[flag];
    return values[flag] || process.env[flag];
  };
  const autostart = truthy(flagOrEnv('OPENAI_AUTOSTART'));
  const maxDecisions = Math.max(0, Math.round(Number(flagOrEnv('OPENAI_MAX_DECISIONS') || 0) || 0));
  const startingStack = Math.max(100, Math.round(Number(flagOrEnv('OPENAI_STARTING_STACK') || 3_000) || 3_000));
  return {
    source: '.env',
    settings: {
      // Default chip stack for every model seat. Override with --starting-stack
      // or OPENAI_STARTING_STACK.
      startingStack,
      // Opt-in launcher demo/benchmark controls. Autostart is off unless the
      // launcher explicitly enables it; maxDecisions hard-stops the tournament.
      autostart,
      maxDecisions,
    },
    connections: [{
      id: connectionId,
      name: isOpenRouter ? 'OpenRouter' : 'OpenAI-compatible',
      kind: isOpenRouter ? 'openrouter' : 'openai',
      baseUrl: resolvedBase,
      apiKey,
      headers: '',
    }],
    players: models.map(({ index, model }, order) => ({
      lobbySeat: Math.max(0, index - 1),
      name: `Player ${index}`,
      connectionId,
      model,
      protocol: isOpenRouter && /(^|\/)typesafe\/jev-/i.test(model.replace(/^~/, '')) ? 'jev_decisions' : 'tool',
      provider: '',
    })),
  };
}

const loadedEnv = await loadArenaEnv();
const arenaEnv = envBootstrap(loadedEnv.values, envOverrides);

if (help) {
  console.log(`pokertools-arena\n\nUsage:\n  npx pokertools-arena [--port 4173] [--host 127.0.0.1] [--chrome] [--no-open] [--no-env] [--autostart] [--starting-stack N] [--max-decisions N]\n\nThe launcher serves the prebuilt static benchmark locally and opens it in your browser so you can watch the tournament. --chrome opens Google Chrome specifically. By default it also reads .env from the current directory and preloads OPENAI_BASE_URL / OPENAI_API_KEY / OPENAI_PLAYER1..10 into page memory. --autostart starts the tournament once seats are loaded, and --max-decisions hard-stops it after N poker decisions. --starting-stack and --max-decisions override .env values. Use --no-env to disable the .env bootstrap.`);
  process.exit(0);
}

const mime = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon'
};

function isLoopbackRequest(req) {
  const address = String(req.socket?.remoteAddress || '');
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

function safePath(urlPath) {
  const clean = decodeURIComponent((urlPath || '/').split('?')[0]);
  const target = clean === '/' ? '/index.html' : clean;
  const resolved = normalize(join(root, target));
  return resolved.startsWith(root) ? resolved : null;
}

async function handleRequest(req, res) {
  try {
    const urlPath = (req.url || '/').split('?')[0];
    if (urlPath === '/arena-env.js') {
      const exposedEnv = arenaEnv && (isLoopbackRequest(req) || !arenaEnv.connections?.some(c => c.apiKey)) ? arenaEnv : null;
      const payload = `window.__POKERTOOLS_ENV__ = ${JSON.stringify(exposedEnv)};\n`;
      res.writeHead(200, { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(payload);
      return;
    }
    const file = safePath(req.url);
    if (!file) throw new Error('Invalid path');
    const info = await stat(file);
    if (!info.isFile()) throw new Error('Not a file');
    const body = await readFile(file);
    res.writeHead(200, {
      'Content-Type': mime[extname(file)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
      'Cross-Origin-Opener-Policy': 'same-origin-allow-popups'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}

function openBrowser(url) {
  const platform = process.platform;
  let command, commandArgs;
  if (useChrome) {
    if (platform === 'darwin') { command = 'open'; commandArgs = ['-a', 'Google Chrome', url]; }
    else if (platform === 'win32') { command = 'cmd'; commandArgs = ['/c', 'start', '', 'chrome', url]; }
    else { command = 'google-chrome'; commandArgs = [url]; }
  } else if (platform === 'darwin') { command = 'open'; commandArgs = [url]; }
  else if (platform === 'win32') { command = 'cmd'; commandArgs = ['/c', 'start', '', url]; }
  else { command = 'xdg-open'; commandArgs = [url]; }
  try { spawn(command, commandArgs, { detached: true, stdio: 'ignore' }).unref(); } catch {}
}

function listen(port) {
  // A fresh Server per attempt. Reusing one Server and calling listen() again
  // from inside its EADDRINUSE handler makes Node emit 'listening' twice, which
  // printed the banner twice and opened two browser windows when the port was
  // already in use.
  const server = createServer(handleRequest);
  server.once('error', error => {
    if (error.code === 'EADDRINUSE' && port < requestedPort + 20) return listen(port + 1);
    console.error(`pokertools-arena: ${error.message}`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    const address = server.address();
    const actualPort = typeof address === 'object' && address ? address.port : port;
    const url = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}/`;
    console.log(`pokertools-arena running at ${url}`);
    if (arenaEnv) console.log(`Loaded .env bootstrap${loadedEnv.source ? ` from ${loadedEnv.source}` : ''}: ${arenaEnv.players.length} player(s), ${arenaEnv.connections[0].baseUrl}`);
    else if (useEnv) console.log('No supported .env bootstrap values found; using browser-saved/manual setup.');
    else console.log('.env bootstrap disabled by --no-env.');
    console.log('Press Ctrl+C to stop the local launcher.');
    if (shouldOpen) openBrowser(url);
  });
}

listen(requestedPort);
