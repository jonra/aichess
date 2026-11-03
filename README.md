# aichess

Chess for people and AI agents. A dependency-free rules engine that follows the FIDE Laws of Chess, a small
HTTP game server that agents can play over, and a browser board for playing, watching, and replaying games.

- **Play** on one screen, or online with an invite link.
- **Let agents play** each other: create a game, hand both agents the join URL, and watch.
- **Replay** any saved game move by move. Games are kept on disk and survive restarts.
- **No dependencies, no build step:** plain ES modules on Node.js 20+ and any modern browser.

New here? Read the **[user guide](docs/USER_GUIDE.md)**.

## Quick start

    git clone https://github.com/jonra/aichess.git
    cd aichess
    npm start                 # game server and board on http://127.0.0.1:8791

Then open http://127.0.0.1:8791 in a browser.

Other commands:

    npm test                  # rules, perft, and server tests
    npm run agent-demo        # two agents play a full game against an in-process server
    echo '{"op":"new"}' | node src/cli.js   # single-process JSON-lines interface

## Rules implemented

- All piece movement, captures, check, checkmate, and stalemate
- Castling (rights tracked, no castling out of, through, or into check)
- En passant (only immediately after a double push, and only if a capture is legal)
- Promotion to Q, R, B, or N
- Automatic draws: stalemate, insufficient material, fivefold repetition, 75-move rule
- Claimable draws: threefold repetition, 50-move rule
- Resignation and mutual draw agreement

Move generation is verified with perft against published reference counts (start position to depth 4,
Kiwipete to depth 3, positions 3 and 4 to depth 3).

## Game server API

Agents on different machines or processes play each other over HTTP. `npm start` listens on
`http://127.0.0.1:8791` and serves the board at `/web/`.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/games` | | Games with an open seat |
| GET | `/history?limit=50` | | All saved games, newest first: players, result, move count |
| POST | `/games` | `{"color":"w","name":"alice"}` | Create a game; the creator gets a seat and token |
| POST | `/games` | `{"name":"host","seat":false}` | Create a game with both seats open, e.g. for two other agents |
| POST | `/games/:id/join` | `{"name":"bob"}` | Take the open seat; get a token |
| GET | `/games/:id?since=V&wait=20` | | View; long-polls until the version passes `V` |
| GET | `/games/:id/stream` | | Server-Sent Events: a snapshot, then every change |
| POST | `/games/:id/move` | `{"uci":"e2e4"}` | Play a move (Bearer token) |
| POST | `/games/:id/resign` | | Resign (Bearer token) |
| POST | `/games/:id/draw` | `{"action":"offer"\|"accept"\|"decline"\|"claim"}` | Draw handling (Bearer token) |

Send the seat token as `Authorization: Bearer <token>`. Create, join, and view responses include `invite`
links to share:

    "invite": {
      "join": "http://127.0.0.1:8791/games/3aa9bce9/join",   // agents POST {"name":"..."} here to take the open seat
      "view": "http://127.0.0.1:8791/games/3aa9bce9",        // GET to follow the game
      "page": "http://127.0.0.1:8791/web/?game=3aa9bce9"     // people open this in a browser to watch or take the seat
    }

Games are saved as JSON in `data/games/` (or `$CHESS_DATA`) after every change and reloaded on start,
seat tokens included, so unfinished games carry on after a restart.

### JavaScript client

`src/agent-client.js` wraps the API:

```js
import { ChessClient } from './src/agent-client.js';

const me = new ChessClient('http://127.0.0.1:8791', 'my-agent');
await me.joinUrl('http://127.0.0.1:8791/games/3aa9bce9/join');  // or create(color), host(), join(gameId)
let game = await me.waitForOpponent();
while (!game.status.over) {
  if (game.turn === me.color) game = await me.move(game.legalMoves[0]);
  else game = await me.wait();                                     // long-poll for the opponent's move
}
```

`node src/host-game.js [name]` and `node src/join-game.js <gameId> [name]` are small runnable examples.

## Agent interface (JSON lines, single process)

`src/cli.js` reads one JSON request per line on stdin and writes one response per line. It is stateless:
each response includes `state`, and the client sends it back with the next request.

| Request | Effect |
|---|---|
| `{"op":"new"}` | Start position |
| `{"op":"load","fen":"..."}` | Position from FEN |
| `{"op":"move","state":S,"uci":"e2e4"}` | Play a move (promotion: `e7e8q`) |
| `{"op":"claim_draw","state":S}` | Claim threefold repetition or 50-move rule |
| `{"op":"resign","state":S,"color":"w"}` | Resign |
| `{"op":"agree_draw","state":S}` | Mutual draw |
| `{"op":"view","state":S}` | Current view |
| `{"op":"perft","fen":"...","depth":3}` | Node count, for checking the engine |

Each response has `fen`, `turn`, `inCheck`, `legalMoves` (UCI), `moves`, `status`
(`over`, `result`, `reason`, `claimable`), and `state`. Illegal moves return `{"ok":false,"error":...}`.

The browser page exposes a similar surface as `window.chess` (`view`, `legalMoves`, `move`, `undo`, `reset`)
for agents driving the page directly.

## Project layout

| Path | What it is |
|---|---|
| `src/engine.js` | Rules engine: move generation, FEN, game status |
| `src/server.js` | HTTP game server, saved games, serves the board |
| `src/agent-client.js` | JavaScript client for the game server |
| `src/cli.js` | JSON-lines interface |
| `web/` | Browser board (`index.html`, `ui.js`, `styles.css`) |
| `test/` | Engine, perft, and server tests (`node --test`) |
| `docs/USER_GUIDE.md` | How to play, watch, and replay |

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE) © 2026 Jon Rasmussen
