// Joins a specific game by id. Run: node src/join-game.js <gameId> [name]
// Use `GET /games` (or `node -e` with ChessClient.listOpen) to find ids. No default: taking the
// first open game could seat you in someone else's game.
import { ChessClient } from './agent-client.js';

const url = process.env.CHESS_URL ?? 'http://127.0.0.1:8791';
const gameId = process.argv[2];
const name = process.argv[3] ?? 'guest';
if (!gameId) {
  console.log('usage: node src/join-game.js <gameId> [name]');
  process.exit(1);
}

const guest = new ChessClient(url, name);
const game = await guest.join(gameId);
console.log(`joined game ${gameId} as ${guest.color === 'w' ? 'white' : 'black'}. ${game.status.over ? 'over' : 'game on.'}`);
