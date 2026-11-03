// Browser board. Two modes share one renderer:
//   local  — the page runs the engine itself (undo, flip, full local play)
//   online — the page follows a game on the game server (SSE updates, moves sent with the seat token)
// The engine in src/engine.js is used for local rules; the server is the authority online.
import * as E from '../src/engine.js';

const SYMBOL = { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' };
const PIECE_NAME = { K: 'King', Q: 'Queen', R: 'Rook', B: 'Bishop', N: 'Knight', P: 'Pawn' };
const REASON = {
  checkmate: 'Checkmate',
  stalemate: 'Stalemate',
  'insufficient-material': 'Draw by insufficient material',
  'fivefold-repetition': 'Draw by fivefold repetition',
  '75-move-rule': 'Draw by the 75-move rule',
  'threefold-repetition': 'Draw by threefold repetition',
  '50-move-rule': 'Draw by the 50-move rule',
  resignation: 'Resignation',
  agreement: 'Draw by agreement',
};
const CLAIM_LABEL = {
  'threefold-repetition': 'Claim draw: threefold repetition',
  '50-move-rule': 'Claim draw: 50-move rule',
};
const VALUE = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
const START_COUNT = { P: 8, N: 2, B: 2, R: 2, Q: 1, K: 1 };
const SESSION_KEY = 'chess-online';
const NAME_KEY = 'chess-name';

const $ = (id) => document.getElementById(id);
const boardEl = $('board');
const movesEl = $('moves');
const activityEl = $('activity');
const promoDialog = $('promo-dialog');
const promoChoices = $('promo-choices');
const claimBtn = $('claim');

let local = E.newGame();
let history = [];
let flipped = false;
let selected = null;
let legal = [];          // legal moves for the current view, as UCI strings
let drag = null;         // pointer drag in progress: { from, x, y, moved, ghost, keep }
let resultSeen = '';     // fen of the finished game whose result overlay was dismissed
// The board can lag behind the game: moves that arrive together are played back one at a time,
// and the move list can show any earlier position.
let playedPly = 0;       // ply shown while following the game; steps toward the latest
let reviewPly = null;    // ply picked from the move list, or null to follow the game
let playTimer = null;
let shownBefore = null;  // { key, ply } last drawn, to animate a one-move step
let noAnimation = false; // the next step was dropped by hand, so it is already in place
const PLAY_DELAY = 650;  // ms per move during playback
const CATCH_UP_DELAY = 300; // ms per move while more than 8 moves behind (not when replaying a saved game)
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
const online = { server: '', gameId: null, token: null, color: null, source: null, view: null, updatedAt: 0, replaying: false };

const sqName = E.sqName;
const isLight = (s) => (s % 8 + Math.floor(s / 8)) % 2 === 1;
const isOnline = () => online.gameId !== null;
const colorOf = (p) => (!p ? null : p === p.toUpperCase() ? 'w' : 'b');
const uciFrom = (u) => E.parseSq(u.slice(0, 2));
const uciTo = (u) => E.parseSq(u.slice(2, 4));

// ---------- views ----------

// One shape for both modes: { fen, turn, inCheck, legalMoves, moves, sans, status, seats?, events?, drawOffer? }
function currentView() {
  if (isOnline()) return online.view;
  const v = E.view(local);
  return { fen: v.fen, turn: v.turn, inCheck: v.inCheck, legalMoves: v.legalMoves, moves: v.moves, sans: v.sans, status: v.status };
}

// Position after the first `ply` moves of the game. Both modes start from the initial position.
const replay = { moves: [], states: [E.newGame()] };
function positionAt(moves, ply) {
  let n = 0;
  while (n < replay.moves.length && n < ply && replay.moves[n] === moves[n]) n++;
  replay.moves.length = n;
  replay.states.length = n + 1;
  for (let i = n; i < ply; i++) {
    replay.states.push(E.makeMove(replay.states[i], moves[i]));
    replay.moves.push(moves[i]);
  }
  const { fen, turn, inCheck } = E.view(replay.states[ply]);
  return { fen, turn, inCheck };
}

// What the board shows: the latest view, or an earlier position from playback or review.
function shownView(latest) {
  const total = latest.moves.length;
  if (playedPly > total) playedPly = total;
  if (reviewPly !== null && reviewPly >= total) reviewPly = null;
  const ply = reviewPly ?? playedPly;
  if (ply === total) return { v: latest, ply, total };
  const notOver = { over: false, result: null, reason: null, claimable: [] };
  return { v: { ...latest, ...positionAt(latest.moves, ply), moves: latest.moves.slice(0, ply), legalMoves: [], status: notOver }, ply, total };
}

// Steps playback forward one move at a time; faster when it is far behind.
function schedulePlayback(total) {
  if (playTimer || playedPly >= total) return;
  playTimer = setTimeout(() => {
    playTimer = null;
    playedPly++;
    render();
  }, total - playedPly > 8 && !online.replaying ? CATCH_UP_DELAY : PLAY_DELAY);
}

// Play / pause: pausing holds the shown position; playing steps on from it to the latest move.
function togglePlay() {
  const total = currentView()?.moves.length ?? 0;
  if (reviewPly !== null) {
    playedPly = reviewPly;
    reviewPly = null;
  } else if (playedPly < total) {
    reviewPly = playedPly;
  } else {
    playedPly = 0; // at the end: play the game again from the start
  }
  render();
}

// Show the latest position straight away, e.g. after this page's own move.
function catchUp() {
  playedPly = currentView()?.moves.length ?? 0;
  reviewPly = null;
}

function setReview(ply) {
  const latest = currentView();
  if (!latest) return;
  const total = latest.moves.length;
  const p = Math.max(0, Math.min(total, ply));
  reviewPly = p >= total ? null : p;
  if (reviewPly === null) playedPly = total;
  selected = null;
  render();
}

// Slides the piece of a single move (and the rook when castling) from its old square to its new one.
function animateMove(uci) {
  if (reduceMotion.matches) return;
  const from = uciFrom(uci);
  const to = uciTo(uci);
  const pairs = [[from, to]];
  if (Math.abs((to % 8) - (from % 8)) === 2 && boardEl.querySelector(`[data-sq="${sqName(to)}"] .piece`)?.textContent === SYMBOL.K) {
    const rank = Math.floor(from / 8) * 8;
    pairs.push(to % 8 === 6 ? [rank + 7, rank + 5] : [rank, rank + 3]);
  }
  for (const [a, b] of pairs) {
    const pieceEl = boardEl.querySelector(`[data-sq="${sqName(b)}"] .piece`);
    const fromEl = boardEl.querySelector(`[data-sq="${sqName(a)}"]`);
    if (!pieceEl || !fromEl) continue;
    const r1 = fromEl.getBoundingClientRect();
    const r2 = pieceEl.parentElement.getBoundingClientRect();
    pieceEl.style.zIndex = 5;
    pieceEl.animate(
      [{ transform: `translate(${r1.left - r2.left}px, ${r1.top - r2.top}px)` }, { transform: 'none' }],
      { duration: 240, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    ).finished.then(() => { pieceEl.style.zIndex = ''; }, () => {});
  }
}

// The seat this page controls: 'w' / 'b' when playing, null when spectating or in local mode.
const mySeat = () => (isOnline() ? online.color : null);

// ---------- rendering ----------

function render() {
  const latest = currentView();
  $('mode-label').textContent = isOnline()
    ? `Online · game ${online.gameId}${mySeat() ? '' : ' · spectating'}`
    : 'Local game';
  renderLive();
  document.querySelectorAll('.lobby').forEach((el) => { el.hidden = isOnline(); });
  if (!latest) {
    boardEl.innerHTML = '';
    $('turn-text').textContent = 'Connecting…';
    $('status-text').hidden = true;
    $('game-over').hidden = true;
    $('result').hidden = true;
    return;
  }
  const { v, ply, total } = shownView(latest);
  schedulePlayback(total);
  legal = v.legalMoves;
  const board = E.parseFEN(v.fen).board;
  const last = v.moves.at(-1);
  const lastFrom = last ? uciFrom(last) : -1;
  const lastTo = last ? uciTo(last) : -1;
  const kingSq = board.indexOf(v.turn === 'w' ? 'K' : 'k');
  const bottomRank = flipped ? 7 : 0;
  const leftFile = flipped ? 7 : 0;
  const ranks = flipped ? [0, 1, 2, 3, 4, 5, 6, 7] : [7, 6, 5, 4, 3, 2, 1, 0];
  const files = flipped ? [7, 6, 5, 4, 3, 2, 1, 0] : [0, 1, 2, 3, 4, 5, 6, 7];
  const canMove = !v.status.over && (!isOnline() || mySeat() === v.turn);

  boardEl.innerHTML = '';
  for (const r of ranks) {
    for (const f of files) {
      const s = r * 8 + f;
      const p = board[s];
      const el = document.createElement('div');
      el.className = `sq ${isLight(s) ? 'light' : 'dark'}`;
      el.dataset.sq = sqName(s);
      el.setAttribute('role', 'gridcell');
      el.tabIndex = 0;
      el.setAttribute('aria-label', `${sqName(s)}${p ? `, ${p === p.toUpperCase() ? 'white' : 'black'} ${PIECE_NAME[p.toUpperCase()].toLowerCase()}` : ', empty'}`);
      if (s === lastFrom || s === lastTo) el.classList.add('last');
      if (s === selected) el.classList.add('sel');
      if (v.inCheck && s === kingSq) el.classList.add('check');
      if (selected !== null && legal.some((u) => uciFrom(u) === selected && uciTo(u) === s)) {
        el.classList.add(p ? 'capture' : 'target');
      }
      if (p) {
        const piece = document.createElement('span');
        piece.className = `piece ${p === p.toUpperCase() ? 'w' : 'b'}`;
        piece.textContent = SYMBOL[p.toUpperCase()];
        if (drag?.moved && drag.from === s) piece.classList.add('dragging');
        el.appendChild(piece);
        if (canMove && colorOf(p) === v.turn) el.classList.add('movable');
      }
      if (f === leftFile) {
        const c = document.createElement('span');
        c.className = 'coord rank';
        c.textContent = r + 1;
        el.appendChild(c);
      }
      if (r === bottomRank) {
        const c = document.createElement('span');
        c.className = 'coord file';
        c.textContent = 'abcdefgh'[f];
        el.appendChild(c);
      }
      el.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onSquare(s); }
      });
      boardEl.appendChild(el);
    }
  }
  const key = isOnline() ? online.gameId : 'local';
  if (shownBefore?.key === key && ply === shownBefore.ply + 1 && !noAnimation) animateMove(latest.moves[ply - 1]);
  shownBefore = { key, ply };
  noAnimation = false;
  renderStatus(v);
  renderPlayers(v);
  renderActivity(latest);
  renderMoves(latest, ply);
  $('fen').textContent = v.fen;
  $('undo').disabled = isOnline() || history.length === 0;
}

function renderStatus(v) {
  const st = v.status;
  const seat = mySeat();
  $('turn-dot').className = `dot${v.turn === 'b' ? ' black' : ''}`;
  $('turn-text').textContent = st.over
    ? 'Game over'
    : `${v.turn === 'w' ? 'White' : 'Black'} to move${seat ? (seat === v.turn ? ' — your turn' : '') : ''}`;
  $('status-text').hidden = st.over || !v.inCheck;
  $('status-text').textContent = 'Check';

  const gameOver = $('game-over');
  const result = $('result');
  if (st.over) {
    const winner = st.result === '1-0' ? 'White wins' : st.result === '0-1' ? 'Black wins' : 'Draw';
    const reason = REASON[st.reason] ?? st.reason;
    gameOver.hidden = false;
    gameOver.textContent = `${winner} · ${reason}`;
    $('result-score').textContent = st.result === '1/2-1/2' ? '½–½' : st.result.replace('-', '–');
    $('result-text').textContent = winner === 'Draw' ? reason : `${winner} by ${reason.toLowerCase()}`;
    $('result-new').hidden = isOnline() && !mySeat();
    result.hidden = resultSeen === v.fen;
  } else {
    gameOver.hidden = true;
    result.hidden = true;
  }

  const claim = st.claimable?.[0];
  claimBtn.hidden = !claim || st.over || !seat;
  claimBtn.textContent = claim ? CLAIM_LABEL[claim] : '';

  // Draw button: offer, accept an incoming offer, or show that an offer is pending.
  const agreeBtn = $('agree');
  const pending = v.drawOffer ?? null;
  agreeBtn.textContent = !isOnline() ? 'Agree draw'
    : pending && pending !== seat ? 'Accept draw'
    : pending && pending === seat ? 'Draw offered'
    : 'Offer draw';
  agreeBtn.disabled = st.over || (isOnline() && (!seat || pending === seat));
  $('resign').disabled = st.over || (isOnline() && !seat);
  $('new').textContent = isOnline() ? 'New local game' : 'New game';
}

// Pieces each side has taken, and the material lead, from the counts left on the board.
function captured(board) {
  const left = {};
  for (const p of board) if (p) left[p] = (left[p] ?? 0) + 1;
  const taken = { w: [], b: [] };   // taken[c] = pieces colour c has captured
  let score = 0;                    // white's material minus black's
  for (const t of ['Q', 'R', 'B', 'N', 'P']) {
    const missingWhite = Math.max(0, START_COUNT[t] - (left[t] ?? 0));
    const missingBlack = Math.max(0, START_COUNT[t] - (left[t.toLowerCase()] ?? 0));
    for (let i = 0; i < missingBlack; i++) taken.w.push(t);
    for (let i = 0; i < missingWhite; i++) taken.b.push(t);
    score += VALUE[t] * ((left[t] ?? 0) - (left[t.toLowerCase()] ?? 0));
  }
  return { taken, score };
}

function renderPlayers(v) {
  const seats = v.seats ?? { w: null, b: null };
  const seatName = (c) => (seats[c] ? seats[c] : isOnline() ? 'Waiting for player…' : (c === 'w' ? 'White' : 'Black'));
  const { taken, score } = captured(E.parseFEN(v.fen).board);
  for (const [id, color] of [['player-white', 'w'], ['player-black', 'b']]) {
    const el = $(id);
    el.querySelector('.pname').textContent = seatName(color);
    const mine = mySeat() === color;
    const turn = v.turn === color && !v.status.over;
    el.querySelector('.pseat').textContent = mine ? 'you' : turn ? 'to move' : '';
    el.classList.toggle('active', turn);
    const lead = color === 'w' ? score : -score;
    el.querySelector('.material').innerHTML = taken[color].map((t) => SYMBOL[t]).join('') + (lead > 0 ? `<b>+${lead}</b>` : '');
  }
  // The board's top plate shows the side at the top of the board.
  const area = $('player-black').parentElement;
  area.prepend(flipped ? $('player-white') : $('player-black'));
  area.append(flipped ? $('player-black') : $('player-white'));
  $('game-head').hidden = !isOnline();
  if (isOnline()) {
    $('game-code').textContent = online.gameId;
    const label = (c) => `${escapeHtml(seatName(c))}${mySeat() === c ? ' (you)' : ''}`;
    $('matchup').innerHTML = `${label('w')}<span class="vs">vs</span>${label('b')}`;
    const base = `${online.server}/games/${online.gameId}`;
    const open = !seats.w || !seats.b;
    $('agent-url-label').textContent = open ? 'Agent join URL' : 'Agent watch URL';
    $('agent-url').textContent = open ? `${base}/join` : base;
    $('invite-url').textContent = inviteLink();
    $('invite-hint').textContent = open ? 'Opens this game in a browser to watch or take the open seat.' : 'Opens this game in a browser to watch.';
    $('take-seat').hidden = !open || mySeat() !== null || v.status.over;
    $('take-seat').textContent = `Take the open seat (${seats.w ? 'black' : 'white'})`;
    $('agent-url-hint').textContent = open
      ? `POST {"name":"my-agent"} to take the ${seats.w ? 'black' : 'white'} seat`
      : 'Both seats taken. GET it to follow the game, or /stream for live updates.';
  }
  $('game-id').textContent = isOnline() ? `Game ${online.gameId}${online.color ? ` · you play ${online.color === 'w' ? 'white' : 'black'}` : ' · spectating'}` : '';
}

function renderLive() {
  const live = $('live');
  live.hidden = !isOnline();
  if (!isOnline()) return;
  const age = Math.round((Date.now() - online.updatedAt) / 1000);
  const connected = online.source && online.source.readyState === EventSource.OPEN;
  live.classList.toggle('off', !connected);
  $('live-text').textContent = connected
    ? (online.updatedAt ? `Live · updated ${age < 2 ? 'just now' : `${age}s ago`}` : 'Live')
    : 'Reconnecting…';
}

function renderActivity(v) {
  $('activity-card').hidden = !isOnline();
  if (!isOnline() || !v.events) {
    activityEl.innerHTML = `<li class="muted">${isOnline() ? 'No activity yet.' : 'Create or join a game to see live activity.'}</li>`;
    return;
  }
  const describe = (e) => {
    const who = e.by ?? (e.color === 'w' ? 'white' : e.color === 'b' ? 'black' : '');
    switch (e.type) {
      case 'created': return `${who} created the game`;
      case 'joined': return `${who} joined as ${e.color === 'w' ? 'white' : 'black'}`;
      case 'move': return `${who} played ${e.san}`;
      case 'resigned': return `${who} resigned`;
      case 'draw-offer': return `${who} offered a draw`;
      case 'draw-accept': return `${who} accepted the draw`;
      case 'draw-decline': return `${who} declined the draw`;
      case 'draw-claim': return `${who} claimed a draw`;
      default: return e.type;
    }
  };
  activityEl.innerHTML = '';
  for (const e of [...v.events].reverse()) {
    const li = document.createElement('li');
    const time = new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    li.innerHTML = `<time>${time}</time><span></span>`;
    li.querySelector('span').textContent = describe(e);
    activityEl.appendChild(li);
  }
}

function renderMoves(v, ply) {
  const sans = v.sans;
  const reviewing = ply < sans.length;
  $('move-nav').hidden = sans.length === 0;
  $('nav-start').disabled = $('nav-back').disabled = ply === 0;
  $('nav-forward').disabled = $('nav-live').disabled = !reviewing;
  const playing = reviewing && reviewPly === null;
  $('nav-play').textContent = playing ? '⏸' : '⏵';
  $('nav-play').title = playing ? 'Pause (Space)' : reviewing ? 'Play (Space)' : 'Replay from the start (Space)';
  $('nav-play').setAttribute('aria-label', playing ? 'Pause' : 'Play');
  $('nav-status').textContent = !reviewing ? 'Live' : reviewPly === null ? `Playing ${ply}/${sans.length}…` : ply === 0 ? 'Start' : `Move ${ply} of ${sans.length}`;
  if (sans.length === 0) {
    movesEl.innerHTML = '<p class="empty">No moves yet.</p>';
    return;
  }
  const rows = [];
  for (let i = 0; i < sans.length; i += 2) {
    const cell = (j) => (j < sans.length
      ? `<td class="m${j === ply - 1 ? ' shown' : ''}${j >= ply ? ' ahead' : ''}" data-ply="${j + 1}" title="Show the position after this move">${sans[j]}</td>`
      : '<td class="m"></td>');
    rows.push(`<tr><td class="n">${i / 2 + 1}.</td>${cell(i)}${cell(i + 1)}</tr>`);
  }
  movesEl.innerHTML = `<table><tbody>${rows.join('')}</tbody></table>`;
  const row = movesEl.querySelector('.shown')?.parentElement;
  if (!reviewing) movesEl.scrollTop = movesEl.scrollHeight;
  else if (row && (row.offsetTop < movesEl.scrollTop || row.offsetTop + row.offsetHeight > movesEl.scrollTop + movesEl.clientHeight)) {
    movesEl.scrollTop = row.offsetTop - movesEl.clientHeight / 2;
  }
}

// ---------- moves ----------

function onSquare(s) {
  const v = currentView();
  if (!v || v.status.over) return;
  if (isBehind()) { setReview(Infinity); return; }
  const seat = mySeat();
  const piece = E.parseFEN(v.fen).board[s];
  const canSelect = (!isOnline() || seat === v.turn) && colorOf(piece) === v.turn;

  if (selected !== null) {
    const picks = legal.filter((u) => uciFrom(u) === selected && uciTo(u) === s);
    if (picks.length) {
      if (picks[0].length === 5) choosePromotion(picks);
      else submit(picks[0]);
      return;
    }
  }
  selected = canSelect ? s : null;
  render();
}

// Pointer input: press a piece and drag it to a square, or tap a piece and then tap its destination.
function squareAt(x, y) {
  const el = document.elementFromPoint(x, y)?.closest('.sq');
  return el && boardEl.contains(el) ? E.parseSq(el.dataset.sq) : null;
}

// True while the board shows an earlier position than the game's latest one.
const isBehind = () => {
  const total = currentView()?.moves.length ?? 0;
  return (reviewPly ?? playedPly) < total;
};

function onPointerDown(e) {
  if (e.button !== 0 || promoDialog.open) return;
  if (isBehind()) { setReview(Infinity); return; }
  const s = squareAt(e.clientX, e.clientY);
  if (s === null) return;
  const v = currentView();
  const piece = v && E.parseFEN(v.fen).board[s];
  const isDestination = selected !== null && legal.some((u) => uciFrom(u) === selected && uciTo(u) === s);
  if (isDestination || !piece || colorOf(piece) !== v.turn) { onSquare(s); return; }
  const keep = selected === s;    // a tap on the selected piece deselects it on release
  if (!keep) onSquare(s);
  if (selected !== s) return;
  e.preventDefault();
  boardEl.setPointerCapture(e.pointerId);
  drag = { from: s, x: e.clientX, y: e.clientY, moved: false, ghost: null, keep, piece };
}

function onPointerMove(e) {
  if (!drag) return;
  if (!drag.moved) {
    if (Math.hypot(e.clientX - drag.x, e.clientY - drag.y) < 4) return;
    drag.moved = true;
    const size = boardEl.getBoundingClientRect().width / 8;
    const ghost = document.createElement('div');
    ghost.className = `drag-ghost ${colorOf(drag.piece)}`;
    ghost.style.cssText = `width:${size}px;height:${size}px;font-size:${size * 0.83}px`;
    ghost.textContent = SYMBOL[drag.piece.toUpperCase()];
    document.body.appendChild(ghost);
    drag.ghost = ghost;
    boardEl.querySelector(`[data-sq="${sqName(drag.from)}"] .piece`)?.classList.add('dragging');
  }
  drag.ghost.style.left = `${e.clientX}px`;
  drag.ghost.style.top = `${e.clientY}px`;
  const over = squareAt(e.clientX, e.clientY);
  boardEl.querySelectorAll('.sq.hover').forEach((el) => el.classList.remove('hover'));
  if (over !== null && legal.some((u) => uciFrom(u) === drag.from && uciTo(u) === over)) {
    boardEl.querySelector(`[data-sq="${sqName(over)}"]`).classList.add('hover');
  }
}

function onPointerUp(e) {
  if (!drag) return;
  const d = drag;
  drag = null;
  d.ghost?.remove();
  if (!d.moved) {
    if (d.keep) { selected = null; render(); }
    return;
  }
  const to = squareAt(e.clientX, e.clientY);
  if (to !== null && to !== d.from && legal.some((u) => uciFrom(u) === d.from && uciTo(u) === to)) {
    noAnimation = true;
    onSquare(to);
  }
  else render();
}

function choosePromotion(picks) {
  promoChoices.innerHTML = '';
  const turn = currentView().turn;
  for (const letter of ['Q', 'R', 'B', 'N']) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = turn;
    btn.textContent = SYMBOL[letter];
    btn.setAttribute('aria-label', PIECE_NAME[letter]);
    btn.title = PIECE_NAME[letter];
    btn.onclick = () => {
      promoDialog.close();
      submit(picks.find((u) => u[4] === letter.toLowerCase()));
    };
    promoChoices.appendChild(btn);
  }
  promoDialog.showModal();
}

async function submit(uci) {
  if (isOnline()) {
    try {
      const view = await api('POST', `/games/${online.gameId}/move`, { uci });
      selected = null;
      applyRemote(view, true);
    } catch (err) {
      toast(err.message);
      selected = null;
      render();
    }
    return;
  }
  history.push(local);
  local = E.makeMove(local, uci);
  selected = null;
  catchUp();
  render();
}

function undo() {
  if (isOnline() || !history.length) return;
  local = history.pop();
  selected = null;
  catchUp();
  render();
}

// ---------- online ----------

function api(method, path, body) {
  const headers = { 'Content-Type': 'application/json' };
  if (online.token) headers.Authorization = `Bearer ${online.token}`;
  return fetch(online.server + path, { method, headers, body: body ? JSON.stringify(body) : undefined })
    .then(async (res) => {
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      return data;
    });
}

// `jump` shows the new position at once (this page's own action, or the first snapshot of a game);
// otherwise new moves are played back one by one.
function applyRemote(view, jump = false) {
  online.view = view;
  online.updatedAt = Date.now();
  if (online.fresh && online.replaying) {
    playedPly = 0;
    reviewPly = null;
  } else if (jump || online.fresh) catchUp();
  online.fresh = false;
  render();
}

// Follows a game over Server-Sent Events. The browser reconnects automatically if the stream drops.
function follow(server, gameId, seat, replaying = false) {
  leaveSource();
  online.replaying = replaying;
  online.server = server;
  online.gameId = gameId;
  online.color = seat?.color ?? null;
  online.token = seat?.token ?? null;
  online.view = null;
  online.fresh = true;
  const source = new EventSource(`${server}/games/${gameId}/stream`);
  source.onmessage = (e) => applyRemote(JSON.parse(e.data));
  source.onopen = () => renderLive();
  source.onerror = () => renderLive();
  online.source = source;
  saveSession();
  selected = null;
  render();
}

function leaveSource() {
  if (online.source) online.source.close();
  online.source = null;
}

function leaveOnline() {
  leaveSource();
  Object.assign(online, { gameId: null, token: null, color: null, view: null, updatedAt: 0, replaying: false });
  sessionStorage.removeItem(SESSION_KEY);
  window.history.replaceState(null, '', location.pathname);
  $('leave').hidden = true;
  selected = null;
  catchUp();
  render();
  refreshGames();
}

function saveSession() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ server: online.server, gameId: online.gameId, token: online.token, color: online.color }));
  } catch { /* storage can be unavailable; the game still works */ }
}

// Server: ?server= if given, else this page's own origin when the game server serves the page, else the default.
// Game: an invite link (?game=) opens that game to watch, unless this tab already holds a seat in it.
async function startup() {
  const params = new URLSearchParams(location.search);
  if (params.get('server')) {
    $('server').value = params.get('server').replace(/\/$/, '');
  } else {
    try {
      const res = await fetch(`${location.origin}/games`);
      if (res.ok && Array.isArray((await res.json()).games)) $('server').value = location.origin;
    } catch { /* not served by the game server */ }
  }
  restoreSession();
  const gameId = params.get('game');
  if (gameId && online.gameId !== gameId) {
    const res = await fetch(`${$('server').value}/games/${encodeURIComponent(gameId)}`).catch(() => null);
    if (res?.ok) {
      // a finished game is replayed from the first move; a running one opens at the latest position
      const game = await res.json().catch(() => null);
      follow($('server').value, gameId, null, Boolean(game?.status?.over));
      $('leave').hidden = false;
    } else {
      toast(res ? `Game ${gameId} isn't on this game server.` : 'Can\'t reach the game server for this invite link.');
      window.history.replaceState(null, '', location.pathname);
    }
  }
  if (isOnline()) $('online-card').open = true;
}

function restoreSession() {
  try {
    const saved = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null');
    if (saved?.gameId) {
      $('server').value = saved.server;
      follow(saved.server, saved.gameId, { color: saved.color, token: saved.token });
      $('leave').hidden = false;
    }
  } catch { /* ignore a corrupt saved session */ }
}

async function refreshGames() {
  if (isOnline()) return;
  const select = $('open-games');
  try {
    const { games } = await fetch(`${$('server').value.replace(/\/$/, '')}/games`).then((r) => r.json());
    const previous = select.value;
    select.innerHTML = games.length
      ? games.map((g) => `<option value="${escapeHtml(g.gameId)}">${escapeHtml(g.host)} · plays ${g.openColor === 'w' ? 'black' : 'white'} · ${escapeHtml(g.gameId)}</option>`).join('')
      : '<option value="">No open games yet</option>';
    if (games.some((g) => g.gameId === previous)) select.value = previous;
  } catch {
    select.innerHTML = '<option value="">Can\'t reach the game server</option>';
  }
}

const timeAgo = (iso) => {
  const s = Math.round((Date.now() - new Date(iso)) / 1000);
  if (!(s >= 0)) return '';
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  return new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

// Every game the server has saved, newest first. Clicking one replays it from the first move.
async function refreshHistory() {
  const list = $('past-games');
  let games;
  try {
    ({ games } = await fetch(`${$('server').value.replace(/\/$/, '')}/history?limit=50`).then((r) => r.json()));
  } catch {
    list.innerHTML = '<li class="muted">Can\'t reach the game server.</li>';
    delete list.dataset.html;
    return;
  }
  if (!Array.isArray(games) || games.length === 0) {
    list.innerHTML = '<li class="muted">Online games are saved here once they start, so you can replay them.</li>';
    delete list.dataset.html;
    return;
  }
  const html = games.map((g) => {
    const moves = Math.ceil(g.plies / 2);
    const state = g.over ? (REASON[g.reason] ?? g.reason) : 'In progress';
    const meta = [state, `${moves} move${moves === 1 ? '' : 's'}`, timeAgo(g.updatedAt)].filter(Boolean).join(' · ');
    return `<li><button class="past-game${g.gameId === online.gameId ? ' current' : ''}" type="button" data-game="${escapeHtml(g.gameId)}" title="Replay game ${escapeHtml(g.gameId)}">
      <span class="players">${escapeHtml(g.white ?? 'open seat')} vs ${escapeHtml(g.black ?? 'open seat')}</span>
      <span class="score">${g.over ? escapeHtml(g.result.replace('1/2-1/2', '½–½')) : '…'}</span>
      <span class="meta">${escapeHtml(meta)}</span>
    </button></li>`;
  }).join('');
  // rebuild only on change, so keyboard focus in the list isn't lost every refresh
  if (html !== list.dataset.html) {
    list.innerHTML = html;
    list.dataset.html = html;
  }
}

function replayGame(gameId) {
  const server = $('server').value.replace(/\/$/, '');
  if (online.gameId === gameId && online.token) {
    // already seated in this game: replay it without giving up the seat
    playedPly = 0;
    reviewPly = null;
    return render();
  }
  follow(server, gameId, null, true);
  $('leave').hidden = false;
  window.history.replaceState(null, '', inviteLink());
  refreshHistory();
}

async function createGame() {
  const server = $('server').value.replace(/\/$/, '');
  const name = playerName();
  const seatless = $('color').value === 'none';
  online.server = server;
  try {
    const game = await fetch(`${server}/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(seatless ? { name, seat: false } : { color: $('color').value || undefined, name }),
    }).then((r) => r.json().then((d) => { if (!r.ok) throw new Error(d.error); return d; }));
    follow(server, game.gameId, game.you);
    $('leave').hidden = false;
    toast(seatless
      ? `Game ${game.gameId} created. Give the join URL to both agents.`
      : `Game ${game.gameId} created. Share the invite link with your opponent.`);
  } catch (err) {
    toast(err.message);
  }
}

// Link for people: this page, opened on the game. The server is included unless the page is served by it.
function inviteLink() {
  const url = new URL(location.pathname, location.origin);
  url.searchParams.set('game', online.gameId);
  if (online.server !== location.origin) url.searchParams.set('server', online.server);
  return url.href;
}

function joinSelected() {
  const gameId = $('open-games').value;
  if (!gameId) return toast('Pick an open game first.');
  return joinGame($('server').value.replace(/\/$/, ''), gameId);
}

async function joinGame(server, gameId) {
  const name = playerName();
  online.server = server;
  try {
    const game = await fetch(`${server}/games/${gameId}/join`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    }).then((r) => r.json().then((d) => { if (!r.ok) throw new Error(d.error); return d; }));
    follow(server, gameId, game.you);
    $('leave').hidden = false;
    toast(`Joined as ${game.you.color === 'w' ? 'white' : 'black'}.`);
  } catch (err) {
    toast(err.message);
  }
}

function watchSelected() {
  const gameId = $('open-games').value;
  if (!gameId) return toast('Pick a game first.');
  follow($('server').value.replace(/\/$/, ''), gameId, null);
  $('leave').hidden = false;
}

// ---------- controls ----------

const escapeHtml = (t) => String(t).replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function playerName() {
  const name = $('name').value.trim() || 'Guest';
  try { localStorage.setItem(NAME_KEY, name); } catch { /* storage can be unavailable */ }
  return name;
}

function newLocalGame() {
  if (isOnline()) leaveOnline();
  local = E.newGame();
  history = [];
  selected = null;
  resultSeen = '';
  catchUp();
  render();
}

function toast(text) {
  const el = $('toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { el.hidden = true; }, 3500);
}

$('create').onclick = createGame;
$('join').onclick = joinSelected;
$('watch').onclick = watchSelected;
$('leave').onclick = leaveOnline;
$('undo').onclick = undo;
$('flip').onclick = () => { flipped = !flipped; render(); };
$('resign').onclick = async () => {
  if (isOnline()) {
    if (!window.confirm('Resign this game?')) return;
    try { applyRemote(await api('POST', `/games/${online.gameId}/resign`, {})); } catch (err) { toast(err.message); }
    return;
  }
  if (local.result || !window.confirm(`Resign as ${local.turn === 'w' ? 'White' : 'Black'}?`)) return;
  history.push(local);
  local = E.resign(local, local.turn);
  render();
};
$('agree').onclick = async () => {
  if (isOnline()) {
    const pending = online.view?.drawOffer;
    try {
      applyRemote(await api('POST', `/games/${online.gameId}/draw`, { action: pending && pending !== online.color ? 'accept' : 'offer' }));
    } catch (err) { toast(err.message); }
    return;
  }
  if (local.result) return;
  history.push(local);
  local = E.agreeDraw(local);
  render();
};
claimBtn.onclick = async () => {
  if (isOnline()) {
    try { applyRemote(await api('POST', `/games/${online.gameId}/draw`, { action: 'claim' })); } catch (err) { toast(err.message); }
    return;
  }
  if (local.result) return;
  history.push(local);
  local = E.claimDraw(local);
  render();
};
$('new').onclick = newLocalGame;
$('nav-start').onclick = () => setReview(0);
$('nav-back').onclick = () => setReview((reviewPly ?? playedPly) - 1);
$('nav-forward').onclick = () => setReview((reviewPly ?? playedPly) + 1);
$('nav-live').onclick = () => setReview(Infinity);
$('nav-play').onclick = togglePlay;
$('past-games').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-game]');
  if (btn) replayGame(btn.dataset.game);
});
movesEl.addEventListener('click', (e) => {
  const cell = e.target.closest('td[data-ply]');
  if (cell) setReview(Number(cell.dataset.ply));
});
$('result-new').onclick = newLocalGame;
$('result-dismiss').onclick = () => { resultSeen = currentView()?.fen ?? ''; render(); };
boardEl.addEventListener('pointerdown', onPointerDown);
boardEl.addEventListener('pointermove', onPointerMove);
boardEl.addEventListener('pointerup', onPointerUp);
boardEl.addEventListener('pointercancel', () => { drag?.ghost?.remove(); drag = null; render(); });
$('copy-id').onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText(online.gameId ?? '');
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy ID'; }, 1200);
};
$('take-seat').onclick = () => joinGame(online.server, online.gameId);
$('copy-invite').onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText($('invite-url').textContent);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
};
$('copy-url').onclick = async (e) => {
  const btn = e.currentTarget;
  try {
    await navigator.clipboard.writeText($('agent-url').textContent);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
};
$('copy').onclick = async (e) => {
  const btn = e.currentTarget;
  const fen = currentView()?.fen ?? E.toFEN(local);
  try {
    await navigator.clipboard.writeText(fen);
    btn.textContent = 'Copied';
  } catch {
    btn.textContent = 'Copy failed';
  }
  setTimeout(() => { btn.textContent = 'Copy FEN'; }, 1200);
};
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && selected !== null) { selected = null; render(); }
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === 'z' && (e.metaKey || e.ctrlKey) && !promoDialog.open) { e.preventDefault(); undo(); }
  if (e.key === 'f' && !e.metaKey && !e.ctrlKey && !e.altKey) { flipped = !flipped; render(); }
  if (promoDialog.open || e.metaKey || e.ctrlKey || e.altKey) return;
  const at = reviewPly ?? playedPly;
  if (e.key === ' ' && !e.target.closest('button, .sq') && (currentView()?.moves.length ?? 0) > 0) { e.preventDefault(); togglePlay(); return; }
  const step = { ArrowLeft: at - 1, ArrowRight: at + 1, Home: 0, End: Infinity }[e.key];
  if (step !== undefined && !e.target.closest('.sq')) { e.preventDefault(); setReview(step); }
});

// For agents or scripts driving the page: a small, stable surface.
window.chess = {
  view: () => currentView(),
  legalMoves: () => (currentView()?.legalMoves ?? []),
  move: async (uci) => {
    await submit(uci);
    return currentView();
  },
  undo: () => { undo(); return currentView(); },
  reset: () => { $('new').click(); return currentView(); },
  connection: () => ({
    gameId: online.gameId,
    seat: online.color,
    readyState: online.source ? online.source.readyState : null,
    updatedAt: online.updatedAt,
  }),
};

try { $('name').value = localStorage.getItem(NAME_KEY) ?? ''; } catch { /* storage can be unavailable */ }
await startup();
refreshGames();
refreshHistory();
setInterval(refreshGames, 5000);
setInterval(refreshHistory, 5000);
setInterval(renderLive, 1000);
render();
