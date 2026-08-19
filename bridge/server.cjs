const express = require('express');
const bodyParser = require('body-parser');
const { spawn } = require('child_process');
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { SSEServerTransport } = require('@modelcontextprotocol/sdk/server/sse.js');

const PORT = process.env.PORT || 8080;
const BASE_URL = process.env.BASE_URL || '';
const SSE_PATH = '/sse';
const MESSAGE_PATH = '/message';
const BEARER_TOKEN = process.env.MCP_BEARER_TOKEN || '';
const STDIO_CMD = process.env.STDIO_CMD || 'node build/index.js';

console.error('[bridge] starting');
console.error('[bridge] - port: ' + PORT);
console.error('[bridge] - stdio: ' + STDIO_CMD);
console.error('[bridge] - baseUrl: ' + BASE_URL);
console.error('[bridge] - auth: ' + (BEARER_TOKEN ? 'enabled' : 'disabled'));

const child = spawn(STDIO_CMD, { shell: true, cwd: process.env.CHILD_CWD || '/app' });
child.on('exit', (code, signal) => {
  console.error('[bridge] child exited: code=' + code + ' signal=' + signal + ' — restarting container');
  process.exit(code ?? 1);
});
child.stderr.on('data', (d) => console.error('[bridge] child stderr: ' + d.toString('utf8').trim()));

// IMPORTANT: the actual MCP protocol logic (tools/list, tools/call, etc.) lives
// in the CHILD process (the real nostr-agent-interface MCP server), not in this
// bridge. This Server object is only used to get a spec-compliant SSE
// transport wired up (handshake framing, session ids) — every real message is
// forwarded verbatim to the child's stdin, and every reply from the child's
// stdout is forwarded back out over the SSE transport. Do NOT rely on this
// Server object's own request handling for anything except the base
// initialize/close lifecycle it implements automatically.
const server = new Server({ name: 'nostr-bridge', version: '1.0.0' }, { capabilities: {} });

let currentSession = null; // { transport, sessionId }

const app = express();
app.use((req, res, next) => {
  if (req.path === MESSAGE_PATH) return next();
  return bodyParser.json()(req, res, next);
});

function checkAuth(req, res) {
  if (!BEARER_TOKEN) return true;
  if (req.headers['authorization'] === 'Bearer ' + BEARER_TOKEN) return true;
  res.status(401).json({ status: 'error', code: 401, message: 'Unauthorized' });
  return false;
}

app.get(SSE_PATH, async (req, res) => {
  if (!checkAuth(req, res)) return;
  console.error('[bridge] new SSE connection from ' + req.ip);

  if (currentSession) {
    console.error('[bridge] closing stale session ' + currentSession.sessionId + ' for incoming connection');
    try {
      await currentSession.transport.close();
    } catch (e) {
      console.error('[bridge] error closing stale session (continuing):', e);
    }
    currentSession = null;
  }

  const transport = new SSEServerTransport(BASE_URL + MESSAGE_PATH, res);

  try {
    await server.connect(transport);
  } catch (err) {
    console.error('[bridge] connect error (survived, not crashing):', err);
    if (!res.headersSent) res.status(500).end();
    return;
  }

  currentSession = { transport, sessionId: transport.sessionId };
  console.error('[bridge] session established ' + transport.sessionId);

  transport.onmessage = (msg) => {
    console.error('[bridge] client -> child (session ' + transport.sessionId + '): ' + JSON.stringify(msg));
    child.stdin.write(JSON.stringify(msg) + '\n');
  };

  const clear = () => {
    if (currentSession && currentSession.sessionId === transport.sessionId) currentSession = null;
  };
  const sdkOnClose = transport.onclose;
  transport.onclose = () => {
    sdkOnClose?.();
    console.error('[bridge] session closed ' + transport.sessionId);
    clear();
  };
  const sdkOnError = transport.onerror;
  transport.onerror = (err) => {
    sdkOnError?.(err);
    console.error('[bridge] session error ' + transport.sessionId + ':', err);
    clear();
  };
  req.on('close', clear);
});

app.post(MESSAGE_PATH, async (req, res) => {
  if (!checkAuth(req, res)) return;
  const sessionId = req.query.sessionId;
  if (!currentSession || currentSession.sessionId !== sessionId) {
    return res.status(503).json({ status: 'error', code: 503, message: 'No active session for ' + sessionId });
  }
  await currentSession.transport.handlePostMessage(req, res);
});

app.listen(PORT, () => {
  console.error('[bridge] listening on ' + PORT);
  console.error('[bridge] SSE endpoint: http://localhost:' + PORT + SSE_PATH);
  console.error('[bridge] POST messages: http://localhost:' + PORT + MESSAGE_PATH);
});

let stdoutBuf = '';
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk.toString('utf8');
  const lines = stdoutBuf.split(/\r?\n/);
  stdoutBuf = lines.pop() ?? '';
  for (const line of lines) {
    if (!line.trim()) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      console.error('[bridge] child non-JSON stdout: ' + line);
      continue;
    }
    console.error('[bridge] child -> client: ' + line);
    if (currentSession) {
      try {
        currentSession.transport.send(msg);
      } catch (err) {
        console.error('[bridge] failed to send to session ' + currentSession.sessionId + ':', err);
      }
    } else {
      console.error('[bridge] no active session to deliver child message to (dropped)');
    }
  }
});

process.on('unhandledRejection', (err) => console.error('[bridge] unhandledRejection (survived):', err));
process.on('uncaughtException', (err) => console.error('[bridge] uncaughtException (survived):', err));
