/**
 * MiniMax speaks the OpenAI wire protocol except for one field: it reasons
 * inline unless the request carries `thinking: {"type": "disabled"}`, and it
 * ignores `reasoning_effort`, which is the only reasoning control moxxy's
 * OpenAI-compatible client knows how to send. Left alone the model returns its
 * reasoning as a `<think>` block inside `message.content`; that message goes
 * back in history on the next turn and MiniMax rejects the request with
 * `400 invalid params (2013)`. An agent run therefore dies immediately after
 * its first tool call, while a one-shot with no tool call succeeds - which is
 * why a smoke test does not catch it.
 *
 * This forwards to MiniMax unchanged apart from adding that one field, so the
 * vendor stays reachable through the stock provider. It is deliberately not a
 * general-purpose proxy: it rewrites chat completions and pipes everything
 * else through untouched.
 */
import { createServer } from 'node:http';
import { request as httpsRequest } from 'node:https';

const PORT = Number(process.env.PROXY_PORT ?? 8080);
const UPSTREAM = new URL(process.env.UPSTREAM_BASE_URL ?? 'https://api.minimax.io');
/** Bodies above this are forwarded unread; a chat completion is far smaller. */
const MAX_REWRITE_BYTES = 32 * 1024 * 1024;

/**
 * moxxy emits one assistant turn as TWO messages - the tool call with empty
 * content, then the prose - which leaves the `tool` result no longer adjacent
 * to the call it answers, and the call itself carrying `content: ""`. MiniMax
 * rejects that whole shape with `400 invalid params (2013)`; OpenAI and Z.AI
 * accept it, which is why only this vendor needs the repair.
 *
 * Folding the prose back into the call-bearing message restores the adjacency
 * and gives it real content, losing nothing: it is one turn either way.
 */
function mergeSplitAssistantTurns(messages) {
  const out = [];
  for (const message of messages) {
    const previous = out[out.length - 1];
    const isTrailingProse =
      previous?.role === 'assistant' &&
      message?.role === 'assistant' &&
      Array.isArray(previous.tool_calls) &&
      !Array.isArray(message.tool_calls);
    if (isTrailingProse) {
      const text = [previous.content, message.content].map((part) => String(part ?? '').trim()).filter(Boolean);
      out[out.length - 1] = { ...previous, content: text.join('\n') };
      continue;
    }
    out.push(message);
  }
  return out;
}

/** Add the field only when the caller has not already expressed a preference. */
function withThinkingDisabled(raw) {
  const body = JSON.parse(raw);
  if (body === null || typeof body !== 'object' || Array.isArray(body)) return raw;
  const patched = { ...body };
  if (Array.isArray(patched.messages)) patched.messages = mergeSplitAssistantTurns(patched.messages);
  if (!('thinking' in patched)) {
    // `reasoning_effort` is what moxxy sends and what MiniMax ignores. Dropping
    // it keeps the request honest about which control actually applies.
    delete patched.reasoning_effort;
    patched.thinking = { type: 'disabled' };
  }
  return JSON.stringify(patched);
}

const server = createServer((req, res) => {
  const chunks = [];
  let size = 0;
  let tooLarge = false;

  req.on('data', (chunk) => {
    size += chunk.length;
    if (size > MAX_REWRITE_BYTES) tooLarge = true;
    if (!tooLarge) chunks.push(chunk);
  });

  req.on('end', () => {
    const original = Buffer.concat(chunks);
    let payload = original;

    // Only chat completions carry the field, and only if the body parses. A
    // body we cannot read is forwarded as it arrived rather than rejected:
    // failing here would turn a vendor's new endpoint into an outage.
    if (!tooLarge && req.method === 'POST' && req.url.includes('/chat/completions') && original.length > 0) {
      try {
        payload = Buffer.from(withThinkingDisabled(original.toString('utf8')), 'utf8');
      } catch {
        payload = original;
      }
    }

    const headers = { ...req.headers, host: UPSTREAM.host };
    delete headers['content-length'];
    if (payload.length > 0) headers['content-length'] = String(payload.length);

    const upstream = httpsRequest(
      { protocol: UPSTREAM.protocol, hostname: UPSTREAM.hostname, port: UPSTREAM.port || 443, path: req.url, method: req.method, headers },
      (upstreamRes) => {
        res.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);
        // Piped rather than buffered: completions stream, and holding the
        // response would defeat the streaming the caller asked for.
        upstreamRes.pipe(res);
      },
    );

    upstream.on('error', (err) => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: { message: `minimax proxy: ${err.message}` } }));
    });

    if (payload.length > 0) upstream.write(payload);
    upstream.end();
  });

  req.on('error', () => {
    if (!res.headersSent) res.writeHead(400);
    res.end();
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`minimax proxy listening on ${PORT} -> ${UPSTREAM.origin}`);
});
