// Small client for agents. Wraps the game server's HTTP API and remembers this agent's seat token.
//
//   const alice = new ChessClient('http://127.0.0.1:8791', 'alice');
//   await alice.create('w');
//   alice.invite.join                      // share this URL; another agent POSTs {name} to it to take the seat
//   const bob = new ChessClient(url, 'bob');
//   const open = await bob.listOpen();      // find a game
//   await bob.join(open[0].gameId);
//   const game = await bob.wait();          // long-poll until something changes
//   await bob.move(game.legalMoves[0]);

export class ChessClient {
  constructor(baseUrl, name) {
    this.baseUrl = baseUrl.replace(/\/$/, '');
    this.name = name;
    this.gameId = null;
    this.color = null;
    this.token = null;
    this.version = -1;
    this.invite = null;
  }

  async #request(method, path, body) {
    const res = await fetch(this.baseUrl + path, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const data = await res.json();
    if (!res.ok) throw new Error(`${res.status} ${data.error}`);
    return data;
  }

  #adopt(data) {
    if (data.you) {
      this.gameId = data.gameId;
      this.color = data.you.color;
      this.token = data.you.token;
    }
    if (data.invite) this.invite = data.invite;
    this.version = data.version;
    return data;
  }

  async listOpen() {
    return (await this.#request('GET', '/games')).games;
  }

  async create(color) {
    return this.#adopt(await this.#request('POST', '/games', { color, name: this.name }));
  }

  // Creates a game with both seats open, e.g. to set up a match between two other agents. Returns the invite links.
  async host() {
    const data = await this.#request('POST', '/games', { name: this.name, seat: false });
    this.gameId = data.gameId;
    return this.#adopt(data).invite;
  }

  // Joins from an invite's join URL (…/games/:id/join), on whichever server it points to.
  async joinUrl(url) {
    const match = /\/games\/([^/]+)\/join\/?$/.exec(new URL(url).pathname);
    if (!match) throw new Error(`not a join URL: ${url}`);
    this.baseUrl = new URL(url).origin;
    return this.join(match[1]);
  }

  async join(gameId) {
    return this.#adopt(await this.#request('POST', `/games/${gameId}/join`, { name: this.name }));
  }

  // Long-polls until the game version moves past the last one we saw (or `seconds` pass).
  async wait(seconds = 20) {
    const data = await this.#request('GET', `/games/${this.gameId}?since=${this.version}&wait=${seconds}`);
    this.version = data.version;
    return data;
  }

  // Blocks until both seats are filled. Long-polls in chunks so a timeout is enforced.
  async waitForOpponent(timeoutSeconds = 300) {
    const deadline = Date.now() + timeoutSeconds * 1000;
    let game = await this.view();
    while (!(game.seats.w && game.seats.b)) {
      const left = (deadline - Date.now()) / 1000;
      if (left <= 0) throw new Error('timed out waiting for an opponent');
      game = await this.wait(Math.min(20, left));
    }
    return game;
  }

  async view() {
    return this.#adopt(await this.#request('GET', `/games/${this.gameId}`));
  }

  move(uci) {
    return this.#request('POST', `/games/${this.gameId}/move`, { uci }).then((d) => this.#adopt(d));
  }

  resign() {
    return this.#request('POST', `/games/${this.gameId}/resign`, {}).then((d) => this.#adopt(d));
  }

  draw(action) {
    return this.#request('POST', `/games/${this.gameId}/draw`, { action }).then((d) => this.#adopt(d));
  }
}
