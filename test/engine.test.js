import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as E from '../src/engine.js';

const play = (state, ...moves) => moves.reduce((s, m) => E.makeMove(s, m), state);
const uciList = (state) => E.view(state).legalMoves;

test('perft matches reference counts from the start position', () => {
  const s = E.newGame();
  assert.deepEqual([1, 2, 3].map((d) => E.perft(s, d)), [20, 400, 8902]);
});

test('perft: Kiwipete (castling, en passant, promotions, pins)', () => {
  const s = E.parseFEN('r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1');
  assert.deepEqual([1, 2, 3].map((d) => E.perft(s, d)), [48, 2039, 97862]);
});

test('perft: position 3 (en passant and discovered checks)', () => {
  const s = E.parseFEN('8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - - 0 1');
  assert.deepEqual([1, 2, 3].map((d) => E.perft(s, d)), [14, 191, 2812]);
});

test('perft: position 4 (promotions and castling in check)', () => {
  const s = E.parseFEN('r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq - 0 1');
  assert.deepEqual([1, 2, 3].map((d) => E.perft(s, d)), [6, 264, 9467]);
});

test('perft depth 4 from the start position', () => {
  assert.equal(E.perft(E.newGame(), 4), 197281);
});

test('FEN round-trips', () => {
  const fen = 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq - 0 1';
  assert.equal(E.toFEN(E.parseFEN(fen)), fen);
});

test('makeMove does not mutate its input', () => {
  const s = E.newGame();
  const before = JSON.stringify(s);
  E.makeMove(s, 'e2e4');
  assert.equal(JSON.stringify(s), before);
});

test('illegal and malformed moves are rejected', () => {
  const s = E.newGame();
  assert.throws(() => E.makeMove(s, 'e2e5'));
  assert.throws(() => E.makeMove(s, 'e7e5'));
  assert.throws(() => E.makeMove(s, 'zz99'));
});

test('fool\'s mate ends in checkmate for black', () => {
  const s = play(E.newGame(), 'f2f3', 'e7e5', 'g2g4', 'd8h4');
  assert.equal(s.result.result, '0-1');
  assert.equal(s.result.reason, 'checkmate');
  assert.deepEqual(E.legalMoves(s), []);
  assert.throws(() => E.makeMove(s, 'a2a3'), /game is over/);
});

test('stalemate is a draw', () => {
  const s = E.parseFEN('7k/5Q2/6K1/8/8/8/8/8 b - - 0 1');
  assert.deepEqual(E.status(s).reason, 'stalemate');
  assert.equal(E.status(s).result, '1/2-1/2');
});

test('en passant capture is available right after a double push only', () => {
  const s = play(E.newGame(), 'e2e4', 'a7a6', 'e4e5', 'd7d5');
  assert.ok(uciList(s).includes('e5d6'));
  const later = play(s, 'h2h3', 'a6a5');
  assert.ok(!uciList(later).includes('e5d6'));
});

test('en passant removes the captured pawn', () => {
  const s = play(E.newGame(), 'e2e4', 'a7a6', 'e4e5', 'd7d5', 'e5d6');
  assert.equal(s.board[E.parseSq('d5')], '');
  assert.equal(s.board[E.parseSq('d6')], 'P');
});

test('promotion offers all four pieces and applies the choice', () => {
  const s = E.parseFEN('7k/P7/8/8/8/8/8/K7 w - - 0 1');
  const promos = uciList(s).filter((u) => u.startsWith('a7a8')).sort();
  assert.deepEqual(promos, ['a7a8b', 'a7a8n', 'a7a8q', 'a7a8r']);
  const after = E.makeMove(s, 'a7a8n');
  assert.equal(after.board[E.parseSq('a8')], 'N');
});

test('castling both sides, and rook moves into the corner', () => {
  const s = E.parseFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const shortC = E.makeMove(s, 'e1g1');
  assert.equal(shortC.board[E.parseSq('f1')], 'R');
  assert.equal(shortC.board[E.parseSq('h1')], '');
  const longC = E.makeMove(s, 'e1c1');
  assert.equal(longC.board[E.parseSq('d1')], 'R');
  assert.equal(longC.board[E.parseSq('a1')], '');
});

test('cannot castle through or out of check', () => {
  const through = E.parseFEN('4k3/8/8/8/8/8/8/4K2R w K - 0 1');
  // black rook on f8 attacks f1, so the king may not pass through f1
  const attacked = E.parseFEN('4kr2/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.ok(uciList(through).includes('e1g1'));
  assert.ok(!uciList(attacked).includes('e1g1'));
  // black rook on e8 gives check along the e-file
  const inCheck = E.parseFEN('4r2k/8/8/8/8/8/8/4K2R w K - 0 1');
  assert.ok(!uciList(inCheck).includes('e1g1'));
});

test('castling rights are lost after the king or a rook moves, or a corner rook is captured', () => {
  const s = E.parseFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1');
  const kingMoved = play(s, 'e1e2', 'a8a7', 'e2e1');
  assert.equal(kingMoved.castling.w.k, false);
  assert.equal(kingMoved.castling.w.q, false);
  const rookMoved = play(s, 'h1h2', 'a8a7');
  assert.equal(rookMoved.castling.w.k, false);
  assert.equal(rookMoved.castling.w.q, true);
});

test('pinned pieces cannot move off the pin line', () => {
  const s = E.parseFEN('4r2k/8/8/8/8/8/4B3/4K3 w - - 0 1');
  assert.ok(!uciList(s).some((u) => u.startsWith('e2')));
});

test('in check, only moves that resolve the check are legal', () => {
  const s = E.parseFEN('4r2k/8/8/8/8/8/8/R3K3 w - - 0 1');
  assert.ok(E.status(s).inCheck);
  for (const u of uciList(s)) {
    const after = E.makeMove(s, u);
    assert.ok(!E.isInCheck(after.board, 'w'), `${u} leaves king in check`);
  }
});

test('threefold repetition is claimable, not automatic', () => {
  let s = E.newGame();
  for (let i = 0; i < 2; i++) s = play(s, 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.deepEqual(E.status(s).claimable, ['threefold-repetition']);
  assert.equal(s.result, null);
  const claimed = E.claimDraw(s);
  assert.equal(claimed.result.reason, 'threefold-repetition');
});

test('fivefold repetition ends the game automatically', () => {
  let s = E.newGame();
  for (let i = 0; i < 4; i++) s = play(s, 'g1f3', 'g8f6', 'f3g1', 'f6g8');
  assert.equal(s.result.reason, 'fivefold-repetition');
});

test('50-move rule is claimable at 100 halfmoves', () => {
  const s = E.parseFEN('4k3/8/8/8/8/8/8/R3K3 w - - 100 80');
  assert.deepEqual(E.status(s).claimable, ['50-move-rule']);
  assert.equal(E.claimDraw(s).result.reason, '50-move-rule');
  assert.throws(() => E.claimDraw(E.parseFEN('4k3/8/8/8/8/8/8/R3K3 w - - 10 80')));
});

test('75-move rule ends the game automatically at 150 halfmoves', () => {
  const s = E.makeMove(E.parseFEN('4k3/8/8/8/8/8/8/R3K3 w - - 149 80'), 'a1a2');
  assert.equal(s.result.reason, '75-move-rule');
});

test('insufficient material draws', () => {
  for (const fen of [
    '4k3/8/8/8/8/8/8/4K3 w - - 0 1',
    '4k3/8/8/8/8/8/8/3BK3 w - - 0 1',
    '4k3/8/8/8/8/8/8/3NK3 w - - 0 1',
    // both bishops on dark squares (c1 and f8)
    '4kb2/8/8/8/8/8/8/2B1K3 w - - 0 1',
  ]) {
    assert.equal(E.status(E.parseFEN(fen)).reason, 'insufficient-material', fen);
  }
  assert.equal(E.status(E.parseFEN('4k3/8/8/8/8/8/8/3RK3 w - - 0 1')).over, false);
});

test('resignation and agreed draw end the game', () => {
  assert.equal(E.resign(E.newGame(), 'w').result.result, '0-1');
  assert.equal(E.agreeDraw(E.newGame()).result.reason, 'agreement');
});

test('view exposes legal moves in UCI and a stable FEN', () => {
  const v = E.view(E.newGame());
  assert.equal(v.legalMoves.length, 20);
  assert.ok(v.legalMoves.includes('e2e4'));
  assert.equal(v.fen, E.START_FEN);
});

test('SAN: captures, checkmate suffix, and castling', () => {
  const s = play(E.newGame(), 'e2e4', 'e7e5', 'f1c4', 'b8c6', 'd1h5', 'g8f6', 'h5f7');
  assert.equal(s.sans.at(-1), 'Qxf7#');
  const c = play(E.parseFEN('r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1'), 'e1g1');
  assert.equal(c.sans.at(-1), 'O-O');
});

test('SAN: disambiguates pieces that share a destination', () => {
  const s = E.parseFEN('4k3/8/8/8/8/5N2/8/1N2K3 w - - 0 1');
  const nbd2 = E.makeMove(s, 'b1d2');
  assert.equal(nbd2.sans.at(-1), 'Nbd2');
  assert.equal(E.makeMove(s, 'f3d2').sans.at(-1), 'Nfd2');
});

test('SAN: promotion and check suffix', () => {
  const s = E.parseFEN('7k/P7/8/8/8/8/8/K7 w - - 0 1');
  assert.equal(E.makeMove(s, 'a7a8q').sans.at(-1), 'a8=Q+');
});
