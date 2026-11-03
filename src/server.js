// Multi-agent game server. Agents create games, discover open seats, join, and play over HTTP.
// Rules come from engine.js. Games are saved to data/games/ (one JSON file each) after every change,
// so they survive a restart and finished games can be replayed.
//
//   GET  /games                         list games with an open seat
//   GET  /history?limit=N               all saved games, newest first (players, result, move count)
//   GET  /games/:id/stream              Server-Sent Events: snapshot, then every change
//   POST /games                         {color?, name?, seat?}   -> create, creator gets a seat + token
//                                       (seat: false leaves both seats open, e.g. for two agents)
//   GET  /games/:id?since=V&wait=S      game view; long-polls until version > V (max 30 s)
//   POST /games/:id/join                {name?}                  -> take the open seat + token
//   POST /games/:id/move                {uci}                    -> play a move (needs token)
//   POST /games/:id/resign              {}                       -> resign (needs token)
//   POST /games/:id/draw                {action}                 -> offer | accept | decline | claim
//
// Auth: send the seat token as `Authorization: Bearer <token>`.
//
// Create, join, and view responses carry `invite` links to share: `join` and `view` for agents,
// `page` for people (the browser board, which this server also serves at /web/).

import { createServer } from 'node:http';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as E from './engine.js';

const MAX_BODY = 64 * 1024;
const MAX_WAIT = 30;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

const newSeat = (name) => ({
  name: String(name || 'anonymous').slice(0, 40),
  token: randomBytes(16).toString('hex'),
});

// Public view of a game: no tokens, no engine-internal state.
function publicGame(g) {
  const { state, ...view } = E.view(g.state);
  return {
    gameId: g.id,
    version: g.version,
    seats: { w: g.seats.w?.name ?? null, b: g.seats.b?.name ?? null },
    drawOffer: g.drawOffer,
    events: g.events.slice(-20),
    ...view,
  };
}

// The browser board. Only these files are served, so no request can reach anything else on disk.
const STATIC = {
  '/web/': ['../web/index.html', 'text/html; charset=utf-8'],
  '/web/index.html': ['../web/index.html', 'text/html; charset=utf-8'],
  '/web/ui.js': ['../web/ui.js', 'text/javascript; charset=utf-8'],
  '/web/styles.css': ['../web/styles.css', 'text/css; charset=utf-8'],
  '/src/engine.js': ['./engine.js', 'text/javascript; charset=utf-8'],
};

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) reject(new HttpError(413, 'body too large'));
      else chunks.push(c);
    });
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim();
      if (!text) return resolve({});
      try {
        resolve(JSON.parse(text));
      } catch {
        reject(new HttpError(400, 'body must be JSON'));
      }
    });
    req.on('error', reject);
  });
}

// The address clients used to reach this server, so links work behind a proxy too.
function baseUrl(req) {
  const proto = String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0].trim();
  const host = req.headers['x-forwarded-host'] ?? req.headers.host ?? '127.0.0.1';
  return `${proto}://${host}`;
}

function inviteLinks(base, id) {
  return {
    join: `${base}/games/${id}/join`,
    view: `${base}/games/${id}`,
    page: `${base}/web/?game=${id}`,
  };
}

function send(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json', ...CORS });
  res.end(JSON.stringify(payload));
}

// What a saved game file holds. `log` lists everything that changed the position, in order, so
// loading replays it through the engine: ['move', uci] | ['resign', color] | ['agree'] | ['claim'].
const saved = (g) => ({
  id: g.id,
  host: g.host,
  createdAt: g.createdAt,
  updatedAt: g.updatedAt,
  seats: g.seats,
  drawOffer: g.drawOffer,
  version: g.version,
  events: g.events,
  log: g.log,
});

function replay(log) {
  let state = E.newGame();
  for (const [op, arg] of log) {
    if (op === 'move') state = E.makeMove(state, arg);
    else if (op === 'resign') state = E.resign(state, arg);
    else if (op === 'agree') state = E.agreeDraw(state);
    else if (op === 'claim') state = E.claimDraw(state);
  }
  return state;
}

const blankGame = (fields) => ({
  state: E.newGame(),
  seats: { w: null, b: null },
  drawOffer: null,
  version: 1,
  events: [],
  log: [],
  waiters: [],
  subscribers: new Set(),
  ...fields,
});

// Games are kept in `dataDir` when given (the command line uses data/games); without it they live in memory only.
export function createGameServer({ dataDir = null } = {}) {
  const games = new Map();

  const save = (g) => {
    if (!dataDir) return;
    const file = `${dataDir}/${g.id}.json`;
    writeFileSync(`${file}.tmp`, JSON.stringify(saved(g)));
    renameSync(`${file}.tmp`, file);
  };

  if (dataDir) {
    mkdirSync(dataDir, { recursive: true });
    for (const name of readdirSync(dataDir).filter((n) => n.endsWith('.json'))) {
      try {
        const data = JSON.parse(readFileSync(`${dataDir}/${name}`, 'utf8'));
        games.set(data.id, blankGame({ ...data, state: replay(data.log) }));
      } catch (err) {
        console.error(`skipping saved game ${name}: ${err.message}`);
      }
    }
  }

  const getGame = (id) => {
    const g = games.get(id);
    if (!g) throw new HttpError(404, `no game ${id}`);
    return g;
  };

  const seatOf = (g, req) => {
    const header = req.headers.authorization ?? '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    for (const color of ['w', 'b']) {
      if (g.seats[color] && g.seats[color].token === token) return color;
    }
    throw new HttpError(401, 'missing or invalid token');
  };

  // Record an event for the activity feed, bump the version, and notify every listener.
  const changed = (g, event) => {
    if (event) g.events.push({ at: new Date().toISOString(), ...event });
    if (g.events.length > 50) g.events.splice(0, g.events.length - 50);
    g.version++;
    g.updatedAt = new Date().toISOString();
    save(g);
    const waiters = g.waiters;
    g.waiters = [];
    waiters.forEach((wake) => wake());
    const snapshot = publicGame(g);
    g.subscribers.forEach((push) => push(snapshot));
  };
  const nameOf = (g, color) => g.seats[color]?.name ?? null;

  function waitForChange(g, since, seconds) {
    if (g.version > since || seconds <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        g.waiters = g.waiters.filter((w) => w !== wake);
        resolve();
      }, seconds * 1000);
      const wake = () => {
        clearTimeout(timer);
        resolve();
      };
      g.waiters.push(wake);
    });
  }

  async function handle(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, CORS);
      return res.end();
    }
    const url = new URL(req.url, 'http://localhost');
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(302, { Location: '/web/' + url.search });
      return res.end();
    }
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname];
      const content = await readFile(fileURLToPath(new URL(file, import.meta.url)));
      res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
      return res.end(content);
    }
    const base = baseUrl(req);
    const parts = url.pathname.split('/').filter(Boolean);
    const body = req.method === 'POST' ? await readBody(req) : {};

    // GET /history — every game, newest first
    if (req.method === 'GET' && parts.length === 1 && parts[0] === 'history') {
      const limit = Math.max(1, Math.min(500, Number(url.searchParams.get('limit')) || 100));
      const list = [...games.values()]
        .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''))
        .slice(0, limit)
        .map((g) => {
          const s = E.status(g.state);
          return {
            gameId: g.id,
            white: g.seats.w?.name ?? null,
            black: g.seats.b?.name ?? null,
            host: g.host,
            plies: g.state.moves.length,
            over: s.over,
            result: s.result,
            reason: s.reason,
            createdAt: g.createdAt,
            updatedAt: g.updatedAt,
          };
        });
      return send(res, 200, { games: list });
    }

    if (parts[0] !== 'games') throw new HttpError(404, 'not found');

    // GET /games — discovery: games with an open seat
    if (req.method === 'GET' && parts.length === 1) {
      const open = [...games.values()]
        .filter((g) => !g.seats.w || !g.seats.b)
        .filter((g) => !g.state.result)
        .map((g) => ({
          gameId: g.id,
          openColor: !g.seats.w ? 'w' : 'b',
          host: (g.seats.w ?? g.seats.b)?.name ?? g.host,
          version: g.version,
        }));
      return send(res, 200, { games: open });
    }

    // POST /games — create
    if (req.method === 'POST' && parts.length === 1) {
      const color = body.color === 'b' ? 'b' : body.color === 'w' ? 'w' : Math.random() < 0.5 ? 'w' : 'b';
      const now = new Date().toISOString();
      const g = blankGame({ id: randomUUID().slice(0, 8), host: String(body.name || 'host').slice(0, 40), createdAt: now, updatedAt: now });
      if (body.seat === false) {
        games.set(g.id, g);
        g.events.push({ at: now, type: 'created', by: g.host });
        save(g);
        return send(res, 201, { ...publicGame(g), invite: inviteLinks(base, g.id), you: null });
      }
      g.seats[color] = newSeat(body.name);
      games.set(g.id, g);
      g.events.push({ at: now, type: 'created', color, by: g.seats[color].name });
      save(g);
      return send(res, 201, { ...publicGame(g), invite: inviteLinks(base, g.id), you: { color, token: g.seats[color].token } });
    }

    const g = getGame(parts[1]);
    const action = parts[2];

    // GET /games/:id/stream — Server-Sent Events: a snapshot now, then one event per change
    if (req.method === 'GET' && action === 'stream') {
      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
        ...CORS,
      });
      const push = (snapshot) => res.write(`data: ${JSON.stringify(snapshot)}\n\n`);
      push(publicGame(g));
      g.subscribers.add(push);
      const ping = setInterval(() => res.write(': ping\n\n'), 15000);
      req.on('close', () => {
        clearInterval(ping);
        g.subscribers.delete(push);
      });
      return;
    }

    // GET /games/:id — view, optionally long-polling for a change
    if (req.method === 'GET' && !action) {
      const since = Number(url.searchParams.get('since') ?? -1);
      const wait = Math.min(MAX_WAIT, Number(url.searchParams.get('wait') ?? 0));
      await waitForChange(g, since, wait);
      return send(res, 200, { ...publicGame(g), invite: inviteLinks(base, g.id) });
    }

    // POST /games/:id/join
    if (req.method === 'POST' && action === 'join') {
      const color = !g.seats.w ? 'w' : !g.seats.b ? 'b' : null;
      if (!color) throw new HttpError(409, 'game is full');
      g.seats[color] = newSeat(body.name);
      changed(g, { type: 'joined', color, by: nameOf(g, color) });
      return send(res, 200, { ...publicGame(g), invite: inviteLinks(base, g.id), you: { color, token: g.seats[color].token } });
    }

    if (req.method !== 'POST') throw new HttpError(405, 'method not allowed');
    if (!g.seats.w || !g.seats.b) throw new HttpError(409, 'waiting for an opponent to join');
    const color = seatOf(g, req);

    // POST /games/:id/move
    if (action === 'move') {
      if (g.state.result) throw new HttpError(409, 'game is over');
      if (g.state.turn !== color) throw new HttpError(409, 'not your turn');
      const before = g.state;
      g.state = E.makeMove(before, String(body.uci ?? ''));
      g.log.push(['move', g.state.moves.at(-1)]);
      g.drawOffer = null;
      changed(g, { type: 'move', color, by: nameOf(g, color), san: g.state.sans.at(-1), uci: g.state.moves.at(-1) });
      return send(res, 200, publicGame(g));
    }

    // POST /games/:id/resign
    if (action === 'resign') {
      if (g.state.result) throw new HttpError(409, 'game is over');
      g.state = E.resign(g.state, color);
      g.log.push(['resign', color]);
      changed(g, { type: 'resigned', color, by: nameOf(g, color) });
      return send(res, 200, publicGame(g));
    }

    // POST /games/:id/draw
    if (action === 'draw') {
      if (g.state.result) throw new HttpError(409, 'game is over');
      const op = body.action;
      const by = nameOf(g, color);
      if (op === 'offer') {
        if (g.drawOffer === color) throw new HttpError(409, 'you already offered a draw');
        g.drawOffer = color;
      } else if (op === 'accept') {
        if (!g.drawOffer || g.drawOffer === color) throw new HttpError(409, 'no draw offer from your opponent');
        g.state = E.agreeDraw(g.state);
        g.log.push(['agree']);
      } else if (op === 'decline') {
        if (!g.drawOffer || g.drawOffer === color) throw new HttpError(409, 'no draw offer from your opponent');
        g.drawOffer = null;
      } else if (op === 'claim') {
        g.state = E.claimDraw(g.state);
        g.log.push(['claim']);
      } else {
        throw new HttpError(400, 'action must be offer, accept, decline, or claim');
      }
      changed(g, { type: `draw-${op}`, color, by });
      return send(res, 200, publicGame(g));
    }

    throw new HttpError(404, 'not found');
  }

  const server = createServer(async (req, res) => {
    try {
      await handle(req, res);
    } catch (err) {
      if (err instanceof HttpError) return send(res, err.status, { error: err.message });
      // engine rule errors (illegal move, game over, ...) are client errors
      return send(res, 400, { error: err.message });
    }
  });
  return { server, games };
}

export function startServer({ port = 8791, host = '127.0.0.1', dataDir = null } = {}) {
  const { server, games } = createGameServer({ dataDir });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve({ server, games, port: server.address().port, close: () => server.close() }));
  });
}

// `node src/server.js [port]` runs the server in the foreground. Games are saved to data/games/
// (or $CHESS_DATA).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] ?? 8791);
  const dataDir = process.env.CHESS_DATA ?? fileURLToPath(new URL('../data/games', import.meta.url));
  startServer({ port, dataDir }).then(({ port: p }) => console.log(`chess game server on http://127.0.0.1:${p}`));
}
