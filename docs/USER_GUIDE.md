# User guide

A quick tour of the chess board: playing on one screen, playing online, letting AI agents play,
and replaying saved games.

## Start it

    npm start

Open **http://127.0.0.1:8791** in a browser. The game server also serves the board, so this one
command is all you need. To use another port, run `node src/server.js 9000`.

## Play on one screen

The board opens on a local game for two people sharing a screen.

- **Move** by dragging a piece, or by clicking it and then clicking a highlighted square.
- **Promote** a pawn by picking the piece in the dialog that opens.
- **Undo** takes back the last move (Ctrl/⌘ Z). **Flip** turns the board (F).
- **Agree draw**, **Resign**, and **Claim draw** (shown when threefold repetition or the 50-move rule
  applies) end the game.
- **New game** starts over.

## Play online against a person

1. Open **Play online**, enter your name, pick a colour, and click **Create game**.
2. Click **Copy** next to **Invite link** and send it to your opponent.
3. When they open the link, they click **Take the open seat**. The game starts.

To join a game someone else created, pick it in **Open games** and click **Join**, or open their
invite link. **Watch** follows a game without taking a seat.

Your seat stays with your browser tab: reloading the page keeps you in the game.

## Let two AI agents play

1. In **Play online**, set **Your colour** to **Neither, agents play** and click **Create game**.
2. Copy the **Agent join URL** and give it to both agents.
   Each agent sends `POST <join URL>` with `{"name":"my-agent"}` and gets a colour and a token.
3. Watch the game on the board. Moves are played back one at a time, so fast agents are easy to follow.

Agents can also create games themselves and share the invite. See
[the API in the README](../README.md#game-server-api).

## Replay a game

Every online game is saved on the server as it is played, and survives a server restart.

- **Past games** lists them, newest first, with the players, the result, and the number of moves.
  Click one to replay it from the first move.
- Under **Moves**:
  - **⏵ / ⏸** plays or pauses (Space).
  - **◀ ▶** step one move (← →).
  - **⏮ ⏭** jump to the start or the latest position (Home, End).
  - Click any move to see the position after it.
- Clicking the board while looking back returns to the latest position.
- A game's link (`?game=<id>`) opens it at the latest position; press ⏵ to replay it. Share the link to
  share the game.

Saved games are JSON files in `data/games/`. Delete a file to remove that game from the list.
Set `CHESS_DATA=/some/folder` to keep them elsewhere.

## Keyboard shortcuts

| Key | Action |
|---|---|
| ← → | Previous / next move |
| Home / End | First position / latest position |
| Space | Play or pause playback |
| F | Flip the board |
| Ctrl/⌘ Z | Undo (local games) |
| Esc | Clear the selected piece |

## Hosting it for others

The server binds to `127.0.0.1`. To share it, put it behind a reverse proxy (it respects
`X-Forwarded-Proto` and `X-Forwarded-Host`, so invite links use your public address), or change the host in
`startServer`. There are no accounts: anyone with a game's join URL can take an open seat, and seat
tokens are the only protection for a seat, so serve it over HTTPS.
