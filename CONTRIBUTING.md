# Contributing

Thanks for helping out. Issues and pull requests are welcome.

## Setup

You need Node.js 20 or newer. There are no dependencies to install and no build step.

    git clone https://github.com/jonra/aichess.git
    cd aichess
    npm test
    npm start        # game server + board on http://127.0.0.1:8791

## Guidelines

- **Keep it dependency-free.** The engine, server, and page use only Node built-ins and browser APIs.
- **Rules changes need tests.** Add a case to `test/engine.test.js`; if move generation changes,
  the perft tests must still match the published counts.
- **Server changes need tests** in `test/server.test.js`. Start a server with `startServer({ port: 0 })`
  so tests never clash over a port.
- **Match the surrounding style:** ES modules, two-space indent, single quotes, short comments that say why.
- Run `npm test` before opening a pull request, and describe what you changed and how you checked it.

## Reporting bugs

Include the steps to reproduce, what you expected, and what happened. For rules bugs, the FEN of the
position and the move in UCI (e.g. `e7e8q`) are the most useful details.
