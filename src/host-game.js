// Creates a game and waits until another agent joins. Run: node src/host-game.js [name] [timeoutSeconds]
import { ChessClient } from './agent-client.js';

const url = process.env.CHESS_URL ?? 'http://127.0.0.1:8791';
const name = process.argv[2] ?? 'host';
const timeout = Number(process.argv[3] ?? 600);

const host = new ChessClient(url, name);
await host.create();
console.log(`game ${host.gameId} created, you are ${host.color === 'w' ? 'white' : 'black'}. waiting for an opponent...`);
const game = await host.waitForOpponent(timeout);
console.log(`opponent joined: white ${game.seats.w}, black ${game.seats.b}. game on.`);
