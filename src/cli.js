#!/usr/bin/env node
// JSON-lines agent interface. One request per line on stdin, one response per line on stdout.
// The server is stateless: every response includes `state`, and the client sends it back.
//
// Requests:
//   {"op":"new"}                                  -> view of the start position
//   {"op":"load","fen":"..."}                     -> view of a FEN position
//   {"op":"view","state":{...}}                   -> view of a state
//   {"op":"move","state":{...},"uci":"e2e4"}     -> view after the move
//   {"op":"claim_draw","state":{...}}             -> view after claiming threefold / 50-move
//   {"op":"resign","state":{...},"color":"w"}    -> view after resignation
//   {"op":"agree_draw","state":{...}}             -> view after mutual agreement
//   {"op":"perft","fen":"...","depth":3}          -> node count (for checking the engine)

import { createInterface } from 'node:readline';
import * as E from './engine.js';

function handle(req) {
  const state = () => {
    if (!req.state) throw new Error(`"state" is required for op "${req.op}"`);
    return req.state;
  };
  switch (req.op) {
    case 'new': return E.view(E.newGame());
    case 'load': return E.view(E.parseFEN(req.fen));
    case 'view': return E.view(state());
    case 'move': return E.view(E.makeMove(state(), req.uci));
    case 'claim_draw': return E.view(E.claimDraw(state()));
    case 'resign': return E.view(E.resign(state(), req.color));
    case 'agree_draw': return E.view(E.agreeDraw(state()));
    case 'perft': return { nodes: E.perft(req.fen ? E.parseFEN(req.fen) : req.state, req.depth) };
    default: throw new Error(`unknown op: ${req.op}`);
  }
}

const rl = createInterface({ input: process.stdin });
rl.on('line', (line) => {
  if (!line.trim()) return;
  let out;
  try {
    out = { ok: true, ...handle(JSON.parse(line)) };
  } catch (err) {
    out = { ok: false, error: err.message };
  }
  process.stdout.write(JSON.stringify(out) + '\n');
});
