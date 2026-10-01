import type { IncomingMessage, ServerResponse } from 'node:http';

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly rpcCode = -32000,
  ) {
    super(message);
  }
}

/** Writes a JSON-RPC style error body with the given HTTP status. */
export function sendError(
  res: ServerResponse,
  status: number,
  message: string,
  rpcCode = -32000,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: rpcCode, message }, id: null }));
}

/** Reads and parses a JSON request body, enforcing a size cap. */
export async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buf.length;
    if (size > maxBytes) throw new HttpError(413, 'Request body too large');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Parse error: body is not valid JSON', -32700);
  }
}
