import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { createNovaRenderServer } from '../render/server.mjs';

async function listen(server) {
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

async function close(server) {
  if (!server.listening) return;
  server.closeNovaConnections?.();
  server.closeAllConnections?.();
  const closed = once(server, 'close');
  server.close();
  await closed;
}

test('Render gateway health endpoint responds without depending on Cloudflare', async () => {
  const gateway = createNovaRenderServer({ target: 'https://example.workers.dev' });
  const base = await listen(gateway);
  try {
    const response = await fetch(`${base}/_render/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true, service: 'voxydb-render-gateway', upstream: 'configured' });
  } finally { await close(gateway); }
});

test('Render gateway proxies HTTP requests, body, cookies and browser Origin', async () => {
  const upstream = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      method: req.method,
      url: req.url,
      host: req.headers.host,
      origin: req.headers.origin,
      cookie: req.headers.cookie,
      forwardedHost: req.headers['x-forwarded-host'],
      body: Buffer.concat(chunks).toString(),
    }));
  });
  const upstreamBase = await listen(upstream);
  const gateway = createNovaRenderServer({ target: upstreamBase });
  const gatewayBase = await listen(gateway);
  try {
    const response = await fetch(`${gatewayBase}/api/projects?view=all`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: gatewayBase, cookie: 'voxydb_session=abc' },
      body: JSON.stringify({ name: 'test-project' }),
    });
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.method, 'POST');
    assert.equal(payload.url, '/api/projects?view=all');
    assert.equal(payload.host, new URL(upstreamBase).host);
    assert.equal(payload.origin, gatewayBase);
    assert.equal(payload.cookie, 'voxydb_session=abc');
    assert.equal(payload.forwardedHost, new URL(gatewayBase).host);
    assert.deepEqual(JSON.parse(payload.body), { name: 'test-project' });
  } finally {
    await close(gateway);
    await close(upstream);
  }
});

test('Render gateway forwards WebSocket upgrade requests and tunnels frames', async () => {
  const upstream = http.createServer();
  let observedPath = null;
  let upstreamSocket = null;
  upstream.on('upgrade', (req, socket) => {
    upstreamSocket = socket;
    observedPath = req.url;
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
    socket.on('data', (chunk) => socket.write(chunk));
  });
  const upstreamBase = await listen(upstream);
  const gateway = createNovaRenderServer({ target: upstreamBase });
  const gatewayBase = await listen(gateway);
  const { port } = new URL(gatewayBase);
  const socket = net.connect(Number(port), '127.0.0.1');
  try {
    await once(socket, 'connect');
    let received = '';
    const responsePromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket proxy handshake timed out')), 3000);
      const onData = (chunk) => {
        received += chunk.toString('latin1');
        if (received.includes('\r\n\r\n')) {
          clearTimeout(timeout);
          socket.off('data', onData);
          resolve(received);
        }
      };
      socket.on('data', onData);
      socket.on('error', reject);
    });
    socket.write([
      'GET /v1/projects/prj_demo/collections/posts/realtime?ticket=single-use HTTP/1.1',
      `Host: ${new URL(gatewayBase).host}`,
      'Connection: Upgrade',
      'Upgrade: websocket',
      'Sec-WebSocket-Version: 13',
      'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
      '', '',
    ].join('\r\n'));
    const handshake = await responsePromise;
    assert.match(handshake, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.equal(observedPath, '/v1/projects/prj_demo/collections/posts/realtime?ticket=single-use');
    const echoPromise = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('WebSocket frame tunnel timed out')), 3000);
      socket.once('data', (chunk) => { clearTimeout(timeout); resolve(chunk.toString()); });
      socket.once('error', reject);
    });
    socket.write('voxydb-render-tunnel-test');
    assert.equal(await echoPromise, 'voxydb-render-tunnel-test');
  } finally {
    socket.destroy();
    upstreamSocket?.destroy();
    await close(gateway);
    await close(upstream);
  }
});
