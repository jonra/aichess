import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startServer } from '../src/server.js';
import { ChessClient } from '../src/agent-client.js';

async function withServer(fn) {
  const { port, close } = await startServer({ port: 0 });
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    close();
  }
}

test('create, discover, and join', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const open = await new ChessClient(url, 'bob').listOpen();
    assert.equal(open.length, 1);
    assert.equal(open[0].gameId, alice.gameId);
    assert.equal(open[0].openColor, 'b');

    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    assert.equal(bob.color, 'b');
    assert.deepEqual(await new ChessClient(url, 'x').listOpen(), []);
    await assert.rejects(new ChessClient(url, 'carol').join(alice.gameId), /409 game is full/);
  }));

test('a game created without a seat leaves both seats for joiners', () =>
  withServer(async (url) => {
    const created = await fetch(`${url}/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'host', seat: false }),
    }).then((r) => r.json());
    assert.equal(created.you, null);
    assert.deepEqual(created.seats, { w: null, b: null });
    const open = await new ChessClient(url, 'x').listOpen();
    assert.deepEqual(open.map((g) => [g.gameId, g.openColor, g.host]), [[created.gameId, 'w', 'host']]);

    const a = new ChessClient(url, 'agent-a');
    const b = new ChessClient(url, 'agent-b');
    await a.join(created.gameId);
    await b.join(created.gameId);
    assert.equal(a.color, 'w');
    assert.equal(b.color, 'b');
    assert.deepEqual((await a.move('e2e4')).sans, ['e4']);
  }));

test('create and join responses carry invite links that work', () =>
  withServer(async (url) => {
    const host = new ChessClient(url, 'host');
    const invite = await host.host();
    assert.equal(invite.join, `${url}/games/${host.gameId}/join`);
    assert.equal(invite.view, `${url}/games/${host.gameId}`);
    assert.equal(invite.page, `${url}/web/?game=${host.gameId}`);

    const a = new ChessClient('http://unused.invalid', 'agent-a');
    await a.joinUrl(invite.join);
    assert.equal(a.color, 'w');
    assert.equal(a.invite.join, invite.join);

    const page = await fetch(invite.page);
    assert.equal(page.status, 200);
    assert.match(await page.text(), /<title>Chess<\/title>/);
    assert.equal((await fetch(`${url}/web/../package.json`)).status, 404);
  }));

test('no moves until both seats are filled', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    await assert.rejects(alice.move('e2e4'), /409 waiting for an opponent/);
  }));

test('turn order and tokens are enforced', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    await assert.rejects(bob.move('e7e5'), /409 not your turn/);
    await assert.rejects(new ChessClient(url, 'eve').join(alice.gameId), /409/);
    const outsider = new ChessClient(url, 'eve');
    outsider.gameId = alice.gameId;
    outsider.token = 'not-a-token';
    await assert.rejects(outsider.move('e2e4'), /401 missing or invalid token/);
    const after = await alice.move('e2e4');
    assert.equal(after.turn, 'b');
    assert.deepEqual(after.sans, ['e4']);
  }));

test('illegal moves are rejected without changing the game', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    await new ChessClient(url, 'bob').join(alice.gameId);
    await assert.rejects(alice.move('e2e5'), /400 illegal move/);
    const view = await alice.view();
    assert.equal(view.version, 2);
    assert.equal(view.turn, 'w');
  }));

test('long-poll wakes when the opponent moves', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    const seen = await bob.view();
    const waiting = bob.wait(10);
    setTimeout(() => alice.move('e2e4'), 50);
    const woke = await waiting;
    assert.equal(woke.moves.length, 1);
    assert.ok(woke.version > seen.version);
  }));

test('long-poll returns after the timeout when nothing changes', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    await new ChessClient(url, 'bob').join(alice.gameId);
    await alice.view(); // catch up to the current version
    const started = Date.now();
    const view = await alice.wait(1);
    assert.ok(Date.now() - started >= 900);
    assert.equal(view.moves.length, 0);
  }));

test('draw offer, decline, and accept', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    await alice.draw('offer');
    await assert.rejects(alice.draw('accept'), /409 no draw offer/);
    await bob.draw('decline');
    await alice.draw('offer');
    const done = await bob.draw('accept');
    assert.equal(done.status.result, '1/2-1/2');
    assert.equal(done.status.reason, 'agreement');
    await assert.rejects(alice.move('e2e4'), /409 game is over/);
  }));

test('resignation ends the game for the opponent', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    const done = await bob.resign();
    assert.equal(done.status.result, '1-0');
    assert.equal(done.status.reason, 'resignation');
  }));

test('unknown games and routes return 404', () =>
  withServer(async (url) => {
    const c = new ChessClient(url, 'x');
    c.gameId = 'nope';
    await assert.rejects(c.view(), /404 no game/);
    const res = await fetch(`${url}/elsewhere`);
    assert.equal(res.status, 404);
  }));

test('CORS preflight is answered for browser clients', () =>
  withServer(async (url) => {
    const res = await fetch(`${url}/games`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.match(res.headers.get('access-control-allow-headers'), /Authorization/);
  }));

test('activity feed records joins, moves, and draws', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    await alice.move('e2e4');
    await bob.draw('offer');
    const view = await alice.view();
    assert.deepEqual(view.events.map((e) => e.type), ['created', 'joined', 'move', 'draw-offer']);
    assert.equal(view.events[2].by, 'alice');
    assert.equal(view.events[2].san, 'e4');
  }));

test('event stream pushes a snapshot, then each change', () =>
  withServer(async (url) => {
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    const res = await fetch(`${url}/games/${alice.gameId}/stream`);
    assert.match(res.headers.get('content-type'), /text\/event-stream/);
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const next = async () => {
      while (!buffer.includes('\n\n')) buffer += decoder.decode((await reader.read()).value);
      const [chunk, rest] = [buffer.slice(0, buffer.indexOf('\n\n')), buffer.slice(buffer.indexOf('\n\n') + 2)];
      buffer = rest;
      return JSON.parse(chunk.replace(/^data: /, ''));
    };
    const snapshot = await next();
    assert.equal(snapshot.moves.length, 0);
    await alice.move('e2e4');
    const update = await next();
    assert.equal(update.sans.at(-1), 'e4');
    await reader.cancel();
  }));

test('saved games survive a restart, keep their seats, and are listed in history', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-games-'));
  try {
    let first = await startServer({ port: 0, dataDir });
    let url = `http://127.0.0.1:${first.port}`;
    const alice = new ChessClient(url, 'alice');
    await alice.create('w');
    const bob = new ChessClient(url, 'bob');
    await bob.join(alice.gameId);
    for (const [who, uci] of [[alice, 'f2f3'], [bob, 'e7e5'], [alice, 'g2g4'], [bob, 'd8h4']]) await who.move(uci);
    const other = new ChessClient(url, 'carol');
    await other.create('b');
    const dave = new ChessClient(url, 'dave');
    await dave.join(other.gameId);
    await dave.move('e2e4');
    first.close();

    const second = await startServer({ port: 0, dataDir });
    url = `http://127.0.0.1:${second.port}`;
    try {
      const mate = await fetch(`${url}/games/${alice.gameId}`).then((r) => r.json());
      assert.deepEqual(mate.sans, ['f3', 'e5', 'g4', 'Qh4#']);
      assert.deepEqual(mate.status, { over: true, result: '0-1', reason: 'checkmate', claimable: [] });
      assert.equal(mate.events.at(-1).san, 'Qh4#');

      // the unfinished game carries on with the tokens issued before the restart
      other.baseUrl = url;
      await other.move('e7e5');
      assert.equal((await other.view()).sans.join(' '), 'e4 e5');

      const { games } = await fetch(`${url}/history`).then((r) => r.json());
      assert.deepEqual(games.map((g) => g.gameId), [other.gameId, alice.gameId]);
      assert.deepEqual(
        { white: games[1].white, black: games[1].black, plies: games[1].plies, result: games[1].result, reason: games[1].reason },
        { white: 'alice', black: 'bob', plies: 4, result: '0-1', reason: 'checkmate' },
      );
      assert.equal(games[0].over, false);
    } finally {
      second.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});

test('resignations and agreed draws are replayed from the saved log', async () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'chess-games-'));
  try {
    const first = await startServer({ port: 0, dataDir });
    const url = `http://127.0.0.1:${first.port}`;
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((n) => new ChessClient(url, n));
    await a.create('w'); await b.join(a.gameId); await a.move('e2e4'); await b.resign();
    await c.create('w'); await d.join(c.gameId); await c.draw('offer'); await d.draw('accept');
    first.close();
    const second = await startServer({ port: 0, dataDir });
    try {
      const get = (id) => fetch(`http://127.0.0.1:${second.port}/games/${id}`).then((r) => r.json());
      assert.deepEqual((await get(a.gameId)).status, { over: true, result: '1-0', reason: 'resignation', claimable: [] });
      assert.deepEqual((await get(c.gameId)).status, { over: true, result: '1/2-1/2', reason: 'agreement', claimable: [] });
    } finally {
      second.close();
    }
  } finally {
    rmSync(dataDir, { recursive: true, force: true });
  }
});
