// Chess rules engine (FIDE Laws of Chess). No dependencies, no I/O.
//
// Board: 64-element array, index = rank * 8 + file, a1 = 0, h1 = 7, a8 = 56, h8 = 63.
// Pieces: 'PNBRQK' for white, 'pnbrqk' for black, '' for empty.
// State is plain JSON, so agents can store it, send it, and pass it back.

export const START_FEN = 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq - 0 1';

const FILES = 'abcdefgh';
const KNIGHT = [[1, 2], [2, 1], [2, -1], [1, -2], [-1, -2], [-2, -1], [-2, 1], [-1, 2]];
const KING = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
const DIAG = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
const ORTH = [[1, 0], [-1, 0], [0, 1], [0, -1]];
const ROOK_HOME = { 0: ['w', 'q'], 7: ['w', 'k'], 56: ['b', 'q'], 63: ['b', 'k'] };

export const sqName = (s) => FILES[s % 8] + (Math.floor(s / 8) + 1);
export function parseSq(name) {
  if (!/^[a-h][1-8]$/.test(name)) throw new Error(`bad square: ${name}`);
  return name.charCodeAt(0) - 97 + 8 * (Number(name[1]) - 1);
}
const sqOf = (f, r) => r * 8 + f;
const inBoard = (f, r) => f >= 0 && f < 8 && r >= 0 && r < 8;
const colorOf = (p) => (p === '' ? null : p === p.toUpperCase() ? 'w' : 'b');
const opp = (c) => (c === 'w' ? 'b' : 'w');
const uciOf = (m) => sqName(m.from) + sqName(m.to) + (m.promo ? m.promo.toLowerCase() : '');

// ---------- FEN ----------

export function parseFEN(fen) {
  const [place, turn, castle = '-', ep = '-', half = '0', full = '1'] = fen.trim().split(/\s+/);
  if (turn !== 'w' && turn !== 'b') throw new Error(`bad side to move: ${turn}`);
  const rows = place.split('/');
  if (rows.length !== 8) throw new Error('FEN needs 8 ranks');
  const board = Array(64).fill('');
  rows.forEach((row, i) => {
    let f = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) f += Number(ch);
      else if (/[prnbqkPRNBQK]/.test(ch)) board[sqOf(f++, 7 - i)] = ch;
      else throw new Error(`bad FEN character: ${ch}`);
    }
    if (f !== 8) throw new Error(`rank ${8 - i} does not have 8 files`);
  });
  const state = {
    board,
    turn,
    castling: {
      w: { k: castle.includes('K'), q: castle.includes('Q') },
      b: { k: castle.includes('k'), q: castle.includes('q') },
    },
    ep: ep === '-' ? null : parseSq(ep),
    halfmove: Number(half),
    fullmove: Number(full),
    moves: [],
    sans: [],
    keys: [],
    result: null,
  };
  state.keys = [positionKey(state)];
  return state;
}

export function toFEN(state) {
  const rows = [];
  for (let r = 7; r >= 0; r--) {
    let row = '';
    let empty = 0;
    for (let f = 0; f < 8; f++) {
      const p = state.board[sqOf(f, r)];
      if (!p) { empty++; continue; }
      if (empty) { row += empty; empty = 0; }
      row += p;
    }
    if (empty) row += empty;
    rows.push(row);
  }
  const c = state.castling;
  const rights = (c.w.k ? 'K' : '') + (c.w.q ? 'Q' : '') + (c.b.k ? 'k' : '') + (c.b.q ? 'q' : '');
  return [rows.join('/'), state.turn, rights || '-', state.ep === null ? '-' : sqName(state.ep),
    state.halfmove, state.fullmove].join(' ');
}

export function newGame() {
  return parseFEN(START_FEN);
}

// ---------- attacks and check ----------

function attacked(board, sq, by) {
  const f = sq % 8;
  const r = Math.floor(sq / 8);
  const pawnRank = r + (by === 'w' ? -1 : 1);
  const pawn = by === 'w' ? 'P' : 'p';
  for (const df of [-1, 1]) {
    if (inBoard(f + df, pawnRank) && board[sqOf(f + df, pawnRank)] === pawn) return true;
  }
  const knight = by === 'w' ? 'N' : 'n';
  for (const [df, dr] of KNIGHT) {
    if (inBoard(f + df, r + dr) && board[sqOf(f + df, r + dr)] === knight) return true;
  }
  const king = by === 'w' ? 'K' : 'k';
  for (const [df, dr] of KING) {
    if (inBoard(f + df, r + dr) && board[sqOf(f + df, r + dr)] === king) return true;
  }
  const slide = (dirs, a, b) => {
    for (const [df, dr] of dirs) {
      let x = f + df;
      let y = r + dr;
      while (inBoard(x, y)) {
        const p = board[sqOf(x, y)];
        if (p) {
          if (p === a || p === b) return true;
          break;
        }
        x += df;
        y += dr;
      }
    }
    return false;
  };
  const w = by === 'w';
  return slide(DIAG, w ? 'B' : 'b', w ? 'Q' : 'q') || slide(ORTH, w ? 'R' : 'r', w ? 'Q' : 'q');
}

function kingSquare(board, color) {
  const k = color === 'w' ? 'K' : 'k';
  return board.indexOf(k);
}

export function isInCheck(board, color) {
  const k = kingSquare(board, color);
  return k !== -1 && attacked(board, k, opp(color));
}

// ---------- move generation ----------

function pseudoMoves(state) {
  const { board, turn } = state;
  const moves = [];
  const add = (from, to, piece, captured, flag, promo = null) =>
    moves.push({ from, to, piece, captured, flag, promo });
  const promoPieces = ['Q', 'R', 'B', 'N'];

  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p || colorOf(p) !== turn) continue;
    const type = p.toUpperCase();
    const f = sq % 8;
    const r = Math.floor(sq / 8);

    if (type === 'P') {
      const dir = turn === 'w' ? 1 : -1;
      const startRank = turn === 'w' ? 1 : 6;
      const promoRank = turn === 'w' ? 7 : 0;
      const r1 = r + dir;
      if (!board[sqOf(f, r1)]) {
        const to = sqOf(f, r1);
        if (r1 === promoRank) {
          for (const pr of promoPieces) add(sq, to, p, null, 'promo', pr);
        } else {
          add(sq, to, p, null, 'normal');
          const to2 = sqOf(f, r + 2 * dir);
          if (r === startRank && !board[to2]) add(sq, to2, p, null, 'double');
        }
      }
      for (const df of [-1, 1]) {
        if (!inBoard(f + df, r1)) continue;
        const to = sqOf(f + df, r1);
        const target = board[to];
        if (target && colorOf(target) !== turn) {
          if (r1 === promoRank) {
            for (const pr of promoPieces) add(sq, to, p, target, 'promo', pr);
          } else {
            add(sq, to, p, target, 'normal');
          }
        } else if (!target && to === state.ep) {
          add(sq, to, p, turn === 'w' ? 'p' : 'P', 'ep');
        }
      }
    } else if (type === 'N' || type === 'K') {
      for (const [df, dr] of type === 'N' ? KNIGHT : KING) {
        if (!inBoard(f + df, r + dr)) continue;
        const to = sqOf(f + df, r + dr);
        const target = board[to];
        if (!target || colorOf(target) !== turn) add(sq, to, p, target || null, 'normal');
      }
    } else {
      const dirs = type === 'B' ? DIAG : type === 'R' ? ORTH : DIAG.concat(ORTH);
      for (const [df, dr] of dirs) {
        let x = f + df;
        let y = r + dr;
        while (inBoard(x, y)) {
          const to = sqOf(x, y);
          const target = board[to];
          if (target && colorOf(target) === turn) break;
          add(sq, to, p, target || null, 'normal');
          if (target) break;
          x += df;
          y += dr;
        }
      }
    }
  }

  // Castling: king and rook unmoved (tracked by rights), path empty, king not in or
  // passing through check. The destination check happens in the legality filter.
  const base = turn === 'w' ? 0 : 56;
  const enemy = opp(turn);
  const rights = state.castling[turn];
  const king = turn === 'w' ? 'K' : 'k';
  const rook = turn === 'w' ? 'R' : 'r';
  if (board[base + 4] === king && !attacked(board, base + 4, enemy)) {
    if (rights.k && board[base + 7] === rook && !board[base + 5] && !board[base + 6]
      && !attacked(board, base + 5, enemy)) {
      add(base + 4, base + 6, king, null, 'castle');
    }
    if (rights.q && board[base] === rook && !board[base + 1] && !board[base + 2] && !board[base + 3]
      && !attacked(board, base + 3, enemy)) {
      add(base + 4, base + 2, king, null, 'castle');
    }
  }
  return moves;
}

// Board after a move, with all side effects (ep capture, castling rook, promotion).
function boardAfter(board, m, mover) {
  const next = board.slice();
  next[m.to] = m.promo ? (mover === 'w' ? m.promo : m.promo.toLowerCase()) : next[m.from];
  next[m.from] = '';
  if (m.flag === 'ep') next[m.to + (mover === 'w' ? -8 : 8)] = '';
  if (m.flag === 'castle') {
    const base = m.from - 4;
    if (m.to === base + 6) { next[base + 5] = next[base + 7]; next[base + 7] = ''; }
    else { next[base + 3] = next[base]; next[base] = ''; }
  }
  return next;
}

function generateLegal(state) {
  return pseudoMoves(state).filter((m) => {
    const after = boardAfter(state.board, m, state.turn);
    return !isInCheck(after, state.turn);
  });
}

// ---------- draw rules and status ----------

function effectiveEp(state) {
  if (state.ep === null) return null;
  return generateLegal(state).some((m) => m.flag === 'ep') ? state.ep : null;
}

function positionKey(state) {
  const ep = effectiveEp(state);
  return toFEN(state).split(' ').slice(0, 3).join(' ') + ' ' + (ep === null ? '-' : sqName(ep));
}

// Dead positions per FIDE 5.2.2: no way to force mate. Covers the cases
// K v K, K+minor v K, and K+B v K+B with both bishops on the same colour.
function insufficientMaterial(board) {
  const minors = [];
  for (let sq = 0; sq < 64; sq++) {
    const p = board[sq];
    if (!p) continue;
    const type = p.toUpperCase();
    if (type === 'K') continue;
    if (type === 'P' || type === 'R' || type === 'Q') return false;
    minors.push({ type, light: ((sq % 8) + Math.floor(sq / 8)) % 2 === 1 });
  }
  if (minors.length <= 1) return true;
  return minors.every((m) => m.type === 'B') && minors.every((m) => m.light === minors[0].light);
}

const resultFor = (winner) => (winner === 'w' ? '1-0' : winner === 'b' ? '0-1' : '1/2-1/2');

// Full game status. Automatic endings: checkmate, stalemate, insufficient material,
// fivefold repetition, 75-move rule. Claimable draws (threefold repetition, 50-move
// rule) are reported in `claimable` and only end the game through claimDraw().
export function status(state) {
  if (state.result) return { over: true, ...state.result, inCheck: isInCheck(state.board, state.turn), claimable: [] };
  const inCheck = isInCheck(state.board, state.turn);
  const legal = generateLegal(state);
  if (legal.length === 0) {
    return inCheck
      ? { over: true, result: resultFor(opp(state.turn)), reason: 'checkmate', inCheck, claimable: [] }
      : { over: true, result: '1/2-1/2', reason: 'stalemate', inCheck, claimable: [] };
  }
  if (insufficientMaterial(state.board)) {
    return { over: true, result: '1/2-1/2', reason: 'insufficient-material', inCheck, claimable: [] };
  }
  const key = state.keys[state.keys.length - 1];
  const repeats = state.keys.filter((k) => k === key).length;
  if (repeats >= 5) return { over: true, result: '1/2-1/2', reason: 'fivefold-repetition', inCheck, claimable: [] };
  if (state.halfmove >= 150) return { over: true, result: '1/2-1/2', reason: '75-move-rule', inCheck, claimable: [] };
  const claimable = [];
  if (repeats >= 3) claimable.push('threefold-repetition');
  if (state.halfmove >= 100) claimable.push('50-move-rule');
  return { over: false, result: null, reason: null, inCheck, claimable };
}

// ---------- public API ----------

export function legalMoves(state) {
  if (state.result) return [];
  return generateLegal(state);
}

export function findMove(state, uci) {
  const text = String(uci).trim().toLowerCase();
  if (!/^[a-h][1-8][a-h][1-8][qrbn]?$/.test(text)) throw new Error(`bad move format: ${uci}`);
  const from = parseSq(text.slice(0, 2));
  const to = parseSq(text.slice(2, 4));
  const promo = text.length === 5 ? text[4].toUpperCase() : null;
  return legalMoves(state).find((m) => m.from === from && m.to === to && m.promo === promo) || null;
}

function applyMove(state, m) {
  const mover = state.turn;
  const board = boardAfter(state.board, m, mover);
  const castling = { w: { ...state.castling.w }, b: { ...state.castling.b } };
  const revoke = (sq) => {
    const home = ROOK_HOME[sq];
    if (home) castling[home[0]][home[1]] = false;
  };
  if (m.piece.toUpperCase() === 'K') { castling[mover].k = false; castling[mover].q = false; }
  revoke(m.from);
  revoke(m.to);
  const next = {
    board,
    turn: opp(mover),
    castling,
    ep: m.flag === 'double' ? (m.from + m.to) / 2 : null,
    halfmove: m.piece.toUpperCase() === 'P' || m.captured ? 0 : state.halfmove + 1,
    fullmove: mover === 'b' ? state.fullmove + 1 : state.fullmove,
    moves: [...state.moves, uciOf(m)],
    sans: state.sans,
    keys: state.keys,
    result: null,
  };
  next.keys = [...state.keys, positionKey(next)];
  return next;
}

// Standard algebraic notation for a legal move, including disambiguation and +/# suffixes.
export function sanOf(state, m) {
  let text;
  if (m.flag === 'castle') {
    text = m.to > m.from ? 'O-O' : 'O-O-O';
  } else if (m.piece.toUpperCase() === 'P') {
    text = (m.captured ? FILES[m.from % 8] + 'x' : '') + sqName(m.to) + (m.promo ? '=' + m.promo : '');
  } else {
    const rivals = generateLegal(state).filter((x) => x.piece === m.piece && x.to === m.to && x.from !== m.from);
    let dis = '';
    if (rivals.length) {
      const sameFile = rivals.some((x) => x.from % 8 === m.from % 8);
      const sameRank = rivals.some((x) => Math.floor(x.from / 8) === Math.floor(m.from / 8));
      dis = !sameFile ? FILES[m.from % 8] : !sameRank ? String(Math.floor(m.from / 8) + 1) : sqName(m.from);
    }
    text = m.piece.toUpperCase() + dis + (m.captured ? 'x' : '') + sqName(m.to);
  }
  const after = status(applyMove(state, m));
  if (after.inCheck) text += after.reason === 'checkmate' ? '#' : '+';
  return text;
}

// Applies a legal move (UCI string or move object). Returns a new state; the
// input is not mutated. Sets `result` when the move ends the game.
export function makeMove(state, input) {
  if (state.result) throw new Error('game is over');
  const m = typeof input === 'string' ? findMove(state, input) : input;
  if (!m || !legalMoves(state).some((x) => x.from === m.from && x.to === m.to && x.promo === m.promo)) {
    throw new Error(`illegal move: ${typeof input === 'string' ? input : JSON.stringify(input)}`);
  }
  let next = applyMove(state, m);
  next = { ...next, sans: [...state.sans, sanOf(state, m)] };
  const s = status(next);
  if (s.over) next = { ...next, result: { result: s.result, reason: s.reason } };
  return next;
}

// Claims a claimable draw (threefold repetition or 50-move rule), as FIDE allows.
export function claimDraw(state) {
  if (state.result) throw new Error('game is over');
  const s = status(state);
  if (s.claimable.length === 0) throw new Error('no draw can be claimed');
  return { ...state, result: { result: '1/2-1/2', reason: s.claimable[0] } };
}

export function resign(state, color) {
  if (state.result) throw new Error('game is over');
  return { ...state, result: { result: resultFor(opp(color)), reason: 'resignation' } };
}

export function agreeDraw(state) {
  if (state.result) throw new Error('game is over');
  return { ...state, result: { result: '1/2-1/2', reason: 'agreement' } };
}

// Counts leaf nodes at a given depth. Used to verify move generation.
export function perft(state, depth) {
  if (depth === 0) return 1;
  let n = 0;
  for (const m of generateLegal(state)) {
    n += depth === 1 ? 1 : perft(applyMove(state, m), depth - 1);
  }
  return n;
}

// Agent-facing snapshot: everything a client needs to decide its next move.
export function view(state) {
  const s = status(state);
  return {
    fen: toFEN(state),
    turn: state.turn,
    inCheck: s.inCheck,
    legalMoves: legalMoves(state).map(uciOf),
    moves: state.moves,
    sans: state.sans,
    status: { over: s.over, result: s.result, reason: s.reason, claimable: s.claimable },
    state,
  };
}
