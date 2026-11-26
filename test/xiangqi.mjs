import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createDomainRuntime } from '../resources/extensions/xiangqi/domain.mjs';
import { chooseMove } from '../resources/extensions/xiangqi/engine.mjs';
import {
  at, BLACK, encodeGame, inCheck, initialBoard, isLegalMove, legalMoves, newGame, notation,
  playMove, positionOutcome, RED, restoreGame, SQUARES
} from '../resources/extensions/xiangqi/rules.mjs';

const square = (row, col) => at(row, col);
const move = (row, col, targetRow, targetCol) => ({ from: square(row, col), to: square(targetRow, targetCol) });
const legal = (board, turn, row, col, targetRow, targetCol) => isLegalMove(board, turn, square(row, col), square(targetRow, targetCol));

function position(pieces, blackKing = [0, 3], redKing = [9, 4]) {
  const board = Array(SQUARES).fill(null);
  board[at(...blackKing)] = 'k';
  board[at(...redKing)] = 'K';
  for (const [row, col, piece] of pieces) board[square(row, col)] = piece;
  return board;
}

test('opening layout, legal move generation and side-relative notation', () => {
  const board = initialBoard();
  assert.equal(board.filter(Boolean).length, 32);
  assert.equal(legalMoves(board, RED).length, 44);
  assert.equal(legalMoves(board, BLACK).length, 44);
  assert.equal(notation(board, move(7, 7, 7, 4)), '炮二平五');
  assert.equal(notation(board, move(2, 1, 2, 4)), '炮2平5');
  assert.equal(notation(board, move(9, 7, 7, 6)), '马二进三');
  assert.equal(legal(board, RED, 9, 0, 5, 0), false);
  assert.equal(legal(board, RED, 9, 0, 7, 0), true);
  assert.equal(legal(board, RED, 0, 1, 2, 0), false);
  assert.deepEqual(board, initialBoard());
});

test('horse legs, elephant eyes and river, palace confinement, and crossed-river pawns', () => {
  const board = position([[7, 2, 'N'], [6, 2, 'P'], [7, 4, 'B'], [4, 8, 'P'], [8, 3, 'A']]);
  assert.equal(legal(board, RED, 7, 2, 5, 3), false);
  assert.equal(legal(board, RED, 7, 2, 6, 4), true);
  assert.equal(legal(board, RED, 7, 4, 5, 6), true);
  board[square(6, 5)] = 'P';
  assert.equal(legal(board, RED, 7, 4, 5, 6), false);
  board[square(5, 8)] = 'B';
  assert.equal(legal(board, RED, 5, 8, 3, 6), false);
  assert.equal(legal(board, RED, 8, 3, 7, 4), false);
  assert.equal(legal(board, RED, 8, 3, 7, 2), false);
  assert.equal(legal(board, RED, 9, 4, 8, 5), false);
  assert.equal(legal(board, RED, 6, 2, 6, 3), false);
  assert.equal(legal(board, RED, 4, 8, 4, 7), true);
  assert.equal(legal(board, RED, 4, 8, 5, 8), false);
});

test('cannons capture across exactly one screen and cannot hop to a vacancy', () => {
  const board = position([[7, 1, 'C'], [5, 1, 'P'], [2, 1, 'r']]);
  assert.equal(legal(board, RED, 7, 1, 2, 1), true);
  assert.equal(legal(board, RED, 7, 1, 3, 1), false);
  assert.equal(legal(board, RED, 7, 1, 6, 1), true);
  board[square(4, 1)] = 'p';
  assert.equal(legal(board, RED, 7, 1, 2, 1), false);
  board[square(4, 1)] = null;
  board[square(5, 1)] = null;
  assert.equal(legal(board, RED, 7, 1, 2, 1), false);
});

test('facing generals and moves leaving a general in check are illegal', () => {
  const board = position([[4, 4, 'R']], [0, 4]);
  assert.equal(legal(board, RED, 4, 4, 4, 3), false);
  assert.equal(legal(board, RED, 4, 4, 5, 4), true);
  board[square(7, 4)] = 'r';
  assert.equal(inCheck(board, RED), true);
  assert.equal(legal(board, RED, 4, 4, 5, 4), false);
  assert.equal(legal(board, RED, 4, 4, 7, 4), true);
  assert.equal(legal(board, RED, 9, 4, 9, 5), true);
});

test('mate and stalemate both lose; fourfold repetition and no-capture limit draw', () => {
  const mate = position([[0, 0, 'R'], [1, 0, 'R']], [0, 4], [9, 5]);
  const stalled = position([[2, 3, 'R'], [2, 5, 'R'], [2, 4, 'P']], [0, 4]);
  assert.deepEqual(positionOutcome(mate, BLACK, [], 0), { winner: RED, reason: 'mate' });
  assert.deepEqual(positionOutcome(stalled, BLACK, [], 0), { winner: RED, reason: 'stalemate' });
  assert.deepEqual(positionOutcome(initialBoard(), RED, [], 100), { winner: null, reason: 'quiet-limit' });
  const cycle = [move(9, 1, 7, 0), move(0, 1, 2, 0), move(7, 0, 9, 1), move(2, 0, 0, 1)];
  const game = [...cycle, ...cycle, ...cycle].reduce(playMove, newGame({ mode: 'local' }));
  assert.deepEqual(game.outcome, { winner: null, reason: 'repetition' });
  assert.deepEqual(restoreGame(encodeGame(game)), game);
  const checkCycle = [move(1, 4, 1, 3), move(0, 3, 0, 4), move(1, 3, 1, 4), move(0, 4, 0, 3)];
  const looping = [...checkCycle, ...checkCycle, ...checkCycle, checkCycle[0]].reduce(playMove,
    { ...newGame({ mode: 'local' }), board: position([[1, 4, 'R']], [0, 3], [9, 5]) });
  assert.deepEqual(looping.outcome, { winner: BLACK, reason: 'perpetual-check' });
});

test('the bounded computer returns legal moves without disturbing the position', () => {
  const board = initialBoard();
  for (const level of ['quiet', 'strong']) {
    const reply = chooseMove(board, BLACK, level);
    assert.ok(reply && isLegalMove(board, BLACK, reply.from, reply.to));
    assert.deepEqual(board, initialBoard());
  }
  assert.equal(chooseMove(position([[0, 0, 'R'], [1, 0, 'R']], [0, 4], [9, 5]), BLACK), null);
});

function storage(initial = null) {
  let content = initial;
  return {
    failWrite: false,
    writes: 0,
    async broker(method, [path, value]) {
      assert.equal(path, 'game.json');
      if (method === 'data.read') return content === null ? null : { content };
      assert.equal(method, 'data.write');
      if (this.failWrite) throw new Error('disk unavailable');
      content = value;
      this.writes++;
      return { ok: true };
    }
  };
}

test('the real broker contract opens empty state, saves AI rounds atomically, and resumes and undoes them', async () => {
  const disk = storage();
  const broker = disk.broker.bind(disk);
  const domain = createDomainRuntime({ broker });
  const emitted = [];
  domain.subscribe(event => emitted.push(event));
  const base = await domain.getSnapshot();
  assert.equal(base.state.saved, false);
  const suggestion = await domain.query('game.hint', {});
  assert.equal(suggestion.version, 0);
  assert.ok(base.state.legal.some(way => way.from === suggestion.move.from && way.to === suggestion.move.to));
  assert.equal(disk.writes, 0);
  const { result } = await domain.execute('game.move', { ...move(6, 4, 5, 4), expected: base.version });
  assert.equal(result.state.moves, 2);
  assert.equal(result.state.saved, true);
  assert.equal(result.state.turn, RED);
  assert.equal(result.state.recent[0].text, '兵五进一');
  assert.equal(disk.writes, 1);
  assert.equal(emitted[0].version, result.version);
  assert.equal(emitted.length, 1);
  domain.close();

  const reopened = createDomainRuntime({ broker });
  const restored = await reopened.getSnapshot();
  assert.deepEqual(restored.state.board, result.state.board);
  assert.equal(restored.state.moves, 2);
  const undone = await reopened.execute('game.undo', { expected: restored.version });
  assert.equal(undone.result.state.moves, 0);
  assert.deepEqual(undone.result.state.board, initialBoard());
});

test('failed writes and stale concurrent moves do not corrupt the live or saved game', async () => {
  const disk = storage();
  const domain = createDomainRuntime({ broker: disk.broker.bind(disk) });
  const local = await domain.execute('game.new', { mode: 'local', expected: 0 });
  disk.failWrite = true;
  const args = { ...move(6, 4, 5, 4), expected: local.version };
  await assert.rejects(domain.execute('game.move', args), /disk unavailable/);
  assert.deepEqual((await domain.getSnapshot()).state, local.result.state);
  disk.failWrite = false;
  const results = await Promise.allSettled([domain.execute('game.move', args), domain.execute('game.move', args)]);
  assert.deepEqual(results.map(item => item.status), ['fulfilled', 'rejected']);
  assert.match(results[1].reason.message, /棋局已更新/);
  assert.equal((await domain.getSnapshot()).state.moves, 1);
  assert.equal(disk.writes, 2);
});

test('invalid saved records are preserved until explicitly replaced by a new game', async () => {
  const disk = storage('{broken');
  const domain = createDomainRuntime({ broker: disk.broker.bind(disk) });
  assert.equal((await domain.getSnapshot()).state.damaged, true);
  await assert.rejects(domain.execute('game.settings', { flipped: true, expected: 0 }), /旧棋谱无法读取/);
  assert.equal(disk.writes, 0);
  assert.equal((await domain.execute('game.new', { mode: 'local', expected: 0 })).result.state.damaged, false);
  assert.equal(disk.writes, 1);
});
