// A minimal, dependency-free MCP server over stdio (newline-delimited JSON-RPC 2.0).
// stdout carries protocol messages only; anything else must go to stderr.

const SUPPORTED = ['2024-11-05', '2025-03-26', '2025-06-18', '2025-11-25'];
const LATEST = '2025-06-18';

export function serve({ name, version, instructions, listTools, callTool }) {
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');

  const progressFor = (token) => {
    if (token === undefined) return undefined;
    let n = 0;
    return (ms, latest) => {
      n += 1;
      const message = `still working (${Math.round(ms / 1000)}s)${latest ? `: ${latest}` : ''}`;
      send({ method: 'notifications/progress', params: { progressToken: token, progress: n, message } });
    };
  };

  async function handle(message) {
    const { id, method, params = {} } = message;
    if (id === undefined || id === null) return; // notification: nothing to answer
    try {
      let result;
      switch (method) {
        case 'initialize':
          result = {
            protocolVersion: SUPPORTED.includes(params.protocolVersion) ? params.protocolVersion : LATEST,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name, version },
            instructions,
          };
          break;
        case 'ping':
          result = {};
          break;
        case 'tools/list':
          result = { tools: listTools() };
          break;
        case 'tools/call':
          try {
            const text = await callTool(params.name, params.arguments || {}, {
              progress: progressFor(params._meta?.progressToken),
            });
            result = { content: [{ type: 'text', text }] };
          } catch (err) {
            result = { content: [{ type: 'text', text: `relay error: ${err?.message || err}` }], isError: true };
          }
          break;
        default:
          return send({ id, error: { code: -32601, message: `Method not found: ${method}` } });
      }
      send({ id, result });
    } catch (err) {
      send({ id, error: { code: -32603, message: String(err?.message || err) } });
    }
  }

  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (chunk) => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        send({ id: null, error: { code: -32700, message: 'Parse error' } });
        continue;
      }
      // Requests run concurrently so a long handoff never blocks a ping.
      for (const m of Array.isArray(message) ? message : [message]) handle(m);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}
