import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const HEALTH_PATH = '/_render/health';
const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'proxy-connection']);

function resolveTarget(value) {
  if (!value) throw new Error('CLOUDFLARE_WORKER_URL is required. Set it to the deployed VoxyDB Worker URL.');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('CLOUDFLARE_WORKER_URL must be a valid URL.'); }
  const localHttp = parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
  if ((!localHttp && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.pathname !== '/' || parsed.search || parsed.hash) {
    throw new Error('CLOUDFLARE_WORKER_URL must be an HTTPS origin (HTTP is allowed only for loopback tests).');
  }
  return parsed;
}

function forwardedHeaders(incoming, request, target) {
  const headers = {};
  for (const [name, value] of Object.entries(incoming)) {
    if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
  }
  headers.host = target.host;
  headers['x-forwarded-host'] = incoming['x-forwarded-host'] || incoming.host || '';
  headers['x-forwarded-proto'] = incoming['x-forwarded-proto'] || (request.socket.encrypted ? 'https' : 'https');
  if (request.socket.remoteAddress) {
    headers['x-forwarded-for'] = [incoming['x-forwarded-for'], request.socket.remoteAddress].filter(Boolean).join(', ');
  }
  return headers;
}

export function createNovaRenderServer({ target, logger = console } = {}) {
  const upstream = target instanceof URL ? target : resolveTarget(target);
  const transport = upstream.protocol === 'https:' ? https : http;

  const activeWebSockets = new Set();
  const server = http.createServer((req, res) => {
    if (req.url?.split('?')[0] === HEALTH_PATH) {
      res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify({ ok: true, service: 'voxydb-render-gateway', upstream: 'configured' }));
      return;
    }

    const upstreamRequest = transport.request({
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || (upstream.protocol === 'https:' ? 443 : 80),
      method: req.method,
      path: req.url || '/',
      headers: forwardedHeaders(req.headers, req, upstream),
      timeout: 30_000,
      servername: upstream.protocol === 'https:' ? upstream.hostname : undefined,
    }, (upstreamResponse) => {
      const headers = {};
      for (const [name, value] of Object.entries(upstreamResponse.headers)) {
        if (value !== undefined && !HOP_BY_HOP.has(name.toLowerCase())) headers[name] = value;
      }
      res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.statusMessage, headers);
      upstreamResponse.pipe(res);
    });

    upstreamRequest.on('timeout', () => upstreamRequest.destroy(new Error('Upstream request timed out')));
    upstreamRequest.on('error', (err) => {
      logger.error?.('VoxyDB Render gateway HTTP error:', err?.message || err);
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify({ error: { code: 'UPSTREAM_UNAVAILABLE', message: 'VoxyDB backend is temporarily unavailable.' } }));
      } else res.destroy(err);
    });
    req.pipe(upstreamRequest);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    if (req.url?.split('?')[0] === HEALTH_PATH) {
      clientSocket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n');
      return;
    }

    const secure = upstream.protocol === 'https:';
    const options = {
      host: upstream.hostname,
      port: Number(upstream.port || (secure ? 443 : 80)),
      servername: secure ? upstream.hostname : undefined,
      ALPNProtocols: secure ? ['http/1.1'] : undefined,
    };
    const upstreamSocket = secure ? tls.connect(options) : net.connect(options);
    activeWebSockets.add(clientSocket);
    clientSocket.once('close', () => activeWebSockets.delete(clientSocket));
    let handshakeSent = false;
    let closed = false;

    const fail = (err) => {
      if (closed) return;
      closed = true;
      logger.error?.('VoxyDB Render gateway WebSocket error:', err?.message || err);
      if (!clientSocket.destroyed) {
        if (!handshakeSent) clientSocket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
        else clientSocket.destroy();
      }
      upstreamSocket.destroy();
    };

    upstreamSocket.once(secure ? 'secureConnect' : 'connect', () => {
      const headers = forwardedHeaders(req.headers, req, upstream);
      headers.connection = 'Upgrade';
      headers.upgrade = req.headers.upgrade || 'websocket';
      const lines = [`${req.method || 'GET'} ${req.url || '/'} HTTP/1.1`];
      for (const [name, value] of Object.entries(headers)) {
        const values = Array.isArray(value) ? value : [value];
        for (const item of values) lines.push(`${name}: ${item}`);
      }
      upstreamSocket.write(`${lines.join('\r\n')}\r\n\r\n`);
      handshakeSent = true;
      if (head?.length) upstreamSocket.write(head);
      clientSocket.pipe(upstreamSocket);
      upstreamSocket.pipe(clientSocket);
    });

    upstreamSocket.on('error', fail);
    clientSocket.on('error', fail);
    clientSocket.on('close', () => upstreamSocket.destroy());
    upstreamSocket.on('close', () => { if (!clientSocket.destroyed) clientSocket.destroy(); });
  });

  server.on('clientError', (_err, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  server.closeNovaConnections = () => {
    for (const socket of activeWebSockets) socket.destroy();
    server.closeAllConnections?.();
  };

  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const upstream = resolveTarget(process.env.CLOUDFLARE_WORKER_URL);
  const port = Number(process.env.PORT || 10000);
  const server = createNovaRenderServer({ target: upstream });
  server.listen(port, '0.0.0.0', () => {
    console.log(`VoxyDB Render gateway listening on ${port}; upstream ${upstream.origin}`);
  });
  const shutdown = () => { server.closeNovaConnections(); server.close(() => process.exit(0)); };
  process.once('SIGTERM', shutdown);
  process.once('SIGINT', shutdown);
}
