// Two agents play a game over HTTP. Alice creates the game, Bob finds it and joins.
// Both pick random legal moves. Run: node src/agent-demo.js
import { startServer } from './server.js';
import { ChessClient } from './agent-client.js';

const { port, close } = await startServer({ port: 0 });
const url = `http://127.0.0.1:${port}`;
const MAX_PLIES = 120;

const alice = new ChessClient(url, 'alice');
await alice.create(); // colour is random unless passed
console.log(`alice created game ${alice.gameId} as ${alice.color === 'w' ? 'white' : 'black'}`);

const bob = new ChessClient(url, 'bob');
const [open] = await bob.listOpen();
console.log(`bob found open game ${open.gameId} hosted by ${open.host}`);
await bob.join(open.gameId);
console.log(`bob joined as ${bob.color === 'w' ? 'white' : 'black'}`);

// Each agent decides from the latest state only. Actions that the server rejects
// (stale state, someone else already acted) are retried after refreshing.
async function play(agent) {
  let game = await agent.view();
  while (!game.status.over) {
    try {
      const atLimit = game.moves.length >= MAX_PLIES;
      if (game.drawOffer && game.drawOffer !== agent.color) {
        game = await agent.draw('accept');
        console.log(`${agent.name} accepted the draw`);
      } else if (game.drawOffer === agent.color || game.turn !== agent.color) {
        game = await agent.wait(5);
      } else if (atLimit) {
        game = await agent.draw('offer');
        console.log(`${agent.name} offered a draw after ${game.moves.length} plies`);
      } else {
        const uci = game.legalMoves[Math.floor(Math.random() * game.legalMoves.length)];
        game = await agent.move(uci);
      }
    } catch (err) {
      console.log(`${agent.name} retrying: ${err.message}`);
      game = await agent.view();
    }
  }
  return game;
}

const [aliceGame] = await Promise.all([play(alice), play(bob)]);
const final = aliceGame;
console.log(`\nfinal: ${final.status.result} (${final.status.reason})`);
console.log(`${final.moves.length} plies`);
console.log(final.sans.map((s, i) => (i % 2 === 0 ? `${i / 2 + 1}. ${s}` : s)).join(' ').replace(/ (?=\d+\.)/g, '\n').slice(0, 800));
close();
