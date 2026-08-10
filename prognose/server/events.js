/**
 * A tiny in-process event bus, plus the server-sent-events fan-out.
 *
 * Why SSE rather than WebSockets: every event here travels server → client,
 * the transport is plain HTTP (so it survives proxies and needs no upgrade
 * handling), and browsers reconnect on their own. A WebSocket would add a
 * dependency and a second protocol to secure for no gain.
 *
 * The bus keeps business logic ignorant of transport — `logic.js` publishes
 * "a trade happened" and has no idea anyone is listening.
 */

const listeners = new Set();

/** Publish an event to every connected client. Never throws at the caller. */
export function publish(type, payload) {
  const frame = { type, at: Date.now(), ...payload };
  for (const listener of listeners) {
    try {
      listener(frame);
    } catch {
      /* a broken pipe must not take down the trade that triggered this */
    }
  }
}

export function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const listenerCount = () => listeners.size;

/* ------------------------------------------------------------------ *
 * SSE transport
 * ------------------------------------------------------------------ */

const HEARTBEAT_MS = 25_000;
/** Refuse to fan out to an unbounded number of sockets. */
const MAX_CLIENTS = Number(process.env.STREAM_MAX_CLIENTS) || 1000;

const clients = new Set();

/** Attach an SSE client to the bus. Returns true if it was accepted. */
export function attachStream(req, res, { userId = null } = {}) {
  if (clients.size >= MAX_CLIENTS) {
    res.writeHead(503, { 'content-type': 'text/plain' }).end('Too many stream clients');
    return false;
  }

  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    // Tell nginx and friends not to buffer this response.
    'x-accel-buffering': 'no',
  });
  res.write('retry: 3000\n\n');

  const send = (frame) => {
    // Personal events (a settlement you were in) only go to their owner.
    if (frame.audience && frame.audience !== userId) return;
    const { audience, ...body } = frame;
    res.write(`event: ${body.type}\ndata: ${JSON.stringify(body)}\n\n`);
  };

  const unsubscribe = subscribe(send);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), HEARTBEAT_MS);
  heartbeat.unref?.();

  const client = { res, close: () => res.end() };
  clients.add(client);

  const cleanup = () => {
    clearInterval(heartbeat);
    unsubscribe();
    clients.delete(client);
  };
  req.on('close', cleanup);
  req.on('error', cleanup);
  res.on('error', cleanup);
  return true;
}

/** Hang up on every stream client, so a deploy does not wait on open sockets. */
export function closeAllStreams() {
  for (const client of clients) {
    try {
      client.close();
    } catch {
      /* already gone */
    }
  }
  clients.clear();
}

export const streamClientCount = () => clients.size;
