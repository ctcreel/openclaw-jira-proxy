import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { WebSocketServer } from 'ws';
import type { WebSocket as WsSocket } from 'ws';

import { GatewayClient } from '../../src/services/gateway-client';

// Find an available port for the test WS server
function getPort(): Promise<number> {
  return new Promise((resolve) => {
    const srv = require('node:net').createServer();
    srv.listen(0, () => {
      const port = srv.address().port as number;
      srv.close(() => resolve(port));
    });
  });
}

describe('GatewayClient', () => {
  let wss: WebSocketServer;
  let port: number;
  let client: GatewayClient;
  let serverSocket: WsSocket | null = null;

  /** Handle the connect handshake on the server side */
  function autoHandleConnect(socket: WsSocket): void {
    serverSocket = socket;
    socket.once('message', (data) => {
      const msg = JSON.parse(String(data));
      if (msg.method === 'connect') {
        socket.send(
          JSON.stringify({
            type: 'res',
            id: msg.id,
            ok: true,
            payload: { protocol: 3 },
          }),
        );
      }
    });
  }

  beforeEach(async () => {
    port = await getPort();
    wss = new WebSocketServer({ port });
  });

  afterEach(async () => {
    serverSocket = null;
    await client?.close();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });

  // --- Connection ---

  it('should connect and complete the handshake', async () => {
    wss.on('connection', autoHandleConnect);
    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await client.connect();
    // No throw = success
  });

  it('should reject connection when server rejects', async () => {
    wss.on('connection', (socket) => {
      serverSocket = socket;
      socket.once('message', (data) => {
        const msg = JSON.parse(String(data));
        socket.send(
          JSON.stringify({
            type: 'res',
            id: msg.id,
            ok: false,
            error: { message: 'Invalid token' },
          }),
        );
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'bad-token');
    await expect(client.connect()).rejects.toThrow('Gateway connect rejected');
  });

  it('should deduplicate concurrent connect calls', async () => {
    let connectCount = 0;
    wss.on('connection', (socket) => {
      connectCount++;
      autoHandleConnect(socket);
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await Promise.all([client.connect(), client.connect(), client.connect()]);
    expect(connectCount).toBe(1);
  });

  it('should be a no-op if already connected', async () => {
    let connectCount = 0;
    wss.on('connection', (socket) => {
      connectCount++;
      autoHandleConnect(socket);
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await client.connect();
    await client.connect();
    expect(connectCount).toBe(1);
  });

  // --- runAndWait ---

  it('should send agent + agent.wait RPCs and return result', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      // After connect, handle subsequent messages
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-123', acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
          expect(msg.params.runId).toBe('run-123');
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-123', status: 'ok' },
            }),
          );
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');

    const result = await client.runAndWait(
      { message: 'test prompt', sessionKey: 'hook:test:1', agentId: 'patch' },
      60_000,
    );

    expect(result.runId).toBe('run-123');
    expect(result.status).toBe('ok');
  });

  it('should pass model through to agent RPC', async () => {
    let capturedAgentParams: Record<string, unknown> | null = null;

    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          capturedAgentParams = msg.params;
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-456', acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-456', status: 'ok' },
            }),
          );
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');

    await client.runAndWait(
      {
        message: 'test',
        agentId: 'patch',
        model: 'anthropic/claude-sonnet-4-6',
      },
      60_000,
    );

    expect(capturedAgentParams).not.toBeNull();
    expect(capturedAgentParams!.model).toBe('anthropic/claude-sonnet-4-6');
    expect(capturedAgentParams!.agentId).toBe('patch');
  });

  it('should propagate agent RPC errors', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: false,
              error: { message: 'Agent not found' },
            }),
          );
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await expect(client.runAndWait({ message: 'test' }, 60_000)).rejects.toThrow('RPC error');
  });

  it('should propagate agent.wait errors', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-err', acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: false,
              error: { message: 'Run crashed' },
            }),
          );
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await expect(client.runAndWait({ message: 'test' }, 60_000)).rejects.toThrow('RPC error');
  });

  // --- Timeout ---

  it('should timeout if agent.wait RPC takes too long', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-slow', acceptedAt: new Date().toISOString() },
            }),
          );
        }
        // Never respond to agent.wait — let it timeout
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await expect(client.runAndWait({ message: 'test' }, 200)).rejects.toThrow('RPC timeout');
  }, 15_000);

  // --- Close ---

  it('should reject pending RPCs when closed', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      // Never respond to agent RPC — let close() reject it
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await client.connect();

    const runPromise = client.runAndWait({ message: 'test' }, 60_000);
    // Give the agent RPC time to send before closing
    await new Promise((r) => setTimeout(r, 50));
    await client.close();

    await expect(runPromise).rejects.toThrow('Client closing');
  });

  it('should reject pending RPCs when server disconnects', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          // Close the connection instead of responding
          setTimeout(() => socket.close(), 50);
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');

    await expect(client.runAndWait({ message: 'test' }, 60_000)).rejects.toThrow(
      'Gateway WS closed',
    );
  });

  // --- Ignored messages ---

  it('should ignore non-response messages', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          // Send some events before the real response
          socket.send(JSON.stringify({ type: 'event', event: 'tick' }));
          socket.send(JSON.stringify({ type: 'event', event: 'presence' }));
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-noise', acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-noise', status: 'ok' },
            }),
          );
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    const result = await client.runAndWait({ message: 'test' }, 60_000);
    expect(result.status).toBe('ok');
  });

  // --- Error handling edge cases ---

  it('should reject connect on WS error', async () => {
    // Don't start a server — use a port that won't connect
    const badPort = port + 9999;
    client = new GatewayClient(`ws://127.0.0.1:${badPort}`, 'test-token');
    await expect(client.connect()).rejects.toThrow();
  });

  it('should handle unparseable messages gracefully', async () => {
    wss.on('connection', (socket) => {
      autoHandleConnect(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'agent') {
          // Send garbage before the real response
          socket.send('this is not valid JSON{{{');
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-parse', acceptedAt: new Date().toISOString() },
            }),
          );
        } else if (msg.method === 'agent.wait') {
          socket.send(
            JSON.stringify({
              type: 'res',
              id: msg.id,
              ok: true,
              payload: { runId: 'run-parse', status: 'ok' },
            }),
          );
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    const result = await client.runAndWait({ message: 'test' }, 60_000);
    expect(result.status).toBe('ok');
  });

  it('should handle unparseable message during connect handshake', async () => {
    wss.on('connection', (socket) => {
      serverSocket = socket;
      socket.once('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.method === 'connect') {
          // Send garbage instead of a valid response
          socket.send('not json');
        }
      });
    });

    client = new GatewayClient(`ws://127.0.0.1:${port}`, 'test-token');
    await expect(client.connect()).rejects.toThrow();
  });
});
