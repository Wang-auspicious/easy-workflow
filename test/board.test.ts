import assert from 'node:assert/strict';
import test, {after} from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {Type} from 'typebox';
import {compile} from '../server/spec/compile.ts';
import {line, station, type Pack} from '../server/spec/dsl.ts';
import {Kernel} from '../server/kernel/kernel.ts';
import {Journal} from '../server/journal.ts';
import {Broker} from '../server/broker.ts';
import {BoardStore} from '../server/board.ts';
import {Collaboration, type CollaborationHost, type CollaborationTurn} from '../server/collaboration.ts';
import type {Executor, StationResult} from '../server/runtime.ts';
import type {BoardPost} from '../shared/board.ts';
import {runAgentStation, type AgentStationDef} from '../server/agent-station.ts';
import type {Docs} from '../server/docs.ts';
import type {Toolbox} from '../server/toolbox.ts';
import {closeModelTransport} from '../server/pi.ts';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'easy-workflow-board-'));
after(() => {
  assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
  fs.rmSync(directory, {recursive: true, force: true});
});
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

function fixturePack(): Pack {
  return {id: 'board-fixture', name: 'Board fixture', version: '1', blurb: 'Local deterministic collaboration',
    resources: {model: 4, cpu: 4, browser: 0, http: 0}, channels: [], links: [], conditions: {},
    order: ['board'], collapsed: [], hints: {}, lines: [line({id: 'board', name: 'Board', layer: 3,
      priority: 'mid', wired: true, blurb: 'Keep unrelated branches independent', stations: [
        station({id: 'seed', name: 'Seed', kind: 'program', role: 'process', resource: 'none', accept: ['Produce the fixture input']}),
        station({id: 'owner', name: 'Owner', kind: 'agent', role: 'process', resource: 'model', accept: ['A supported proof']}),
        station({id: 'other', name: 'Independent branch', kind: 'program', role: 'process', resource: 'none', accept: ['Complete the independent branch']}),
        station({id: 'check', name: 'Reviewer', kind: 'review', role: 'review', resource: 'model',
          returnTo: [{station: 'owner', maxRounds: 3}], accept: ['Proof is supported']}),
        station({id: 'published', name: 'Published', kind: 'store', role: 'store'}),
      ], edges: [['seed', 'owner'], ['seed', 'other'], ['owner', 'check'], ['check', 'published'], ['other', 'published']]})]};
}

function fixture(name: string, execute: Executor, options: {modelWorkers?: number;
  turn?: (turn: CollaborationTurn) => Promise<StationResult>} = {}) {
  const compiled = compile([fixturePack()]);
  assert.deepEqual(compiled.issues, []);
  const journal = new Journal(path.join(directory, `${name}.db`));
  const broker = new Broker({model: 4, modelWorkers: options.modelWorkers ?? 4, cpu: 4}, 0);
  const kernel = new Kernel(compiled, journal, broker, {}, () => execute);
  const board = new BoardStore(journal, compiled, {'board/owner': {outputKey: 'proof'},
    'board/check': {outputKey: 'review'}, 'board/other': {outputKey: 'unrelated'}});
  const host: CollaborationHost = {
    compiled, getItem: id => kernel.store.get(id),
    view: id => ({proof: kernel.store.get(id)?.data.proof}),
    owner: (id, field) => {
      const item = kernel.store.get(id);
      return item && board.owners(item, field)[0];
    },
    runTurn: options.turn ?? (async () => {throw new Error('Unexpected collaboration model turn');}),
    programJudge: () => ({decided: false}),
    evidenceText: (_id, evidence) => evidence === 'fixture-evidence' ? 'A literal observation supports the corrected proof.' : undefined,
    applyResolution: (id, field, value, owner, room) => kernel.applyRoomResolution(id, field, value, owner, room),
    park: (id, node, reason, code) => kernel.parkCollaboration(id, node, reason, code),
  };
  const collaboration = new Collaboration(board, host);
  kernel.configureCollaboration({board,
    openRoom: (item, field, topic) => board.createRoom({item: item.id, field, topic,
      participants: ['board/owner', 'board/check'], judge: 'board/check', maxRounds: 3}),
    runRoom: (room, signal) => collaboration.runRoom(room, signal),
    answer: (question, signal) => collaboration.answer(question, signal),
  });
  return {compiled, journal, broker, kernel, board, collaboration, host,
    start: () => {kernel.start(name); return kernel.create('board/seed', {item: name, url: 'https://fixture.invalid', source: 'fixture'});},
    close: async () => {await kernel.close(); journal.close();}};
}

const normal: Executor = async ctx => ({ok: true, summary: `Completed ${ctx.node.key}`,
  data: ctx.node.id === 'owner' ? {proof: 'original'} : ctx.node.id === 'check' ? {review: 'pass'} :
    ctx.node.id === 'other' ? {unrelated: true} : {seed: true}});

test('D automatic claims share the item transaction, retain evidence and supersede prior field claims', async () => {
  const value = fixture('claims', async ctx => {
    if (ctx.node.id === 'owner') ctx.addEvidence({id: `proof-${ctx.attempt}`, kind: 'text', label: 'Fixture-only proof'});
    return normal(ctx);
  });
  const receipts: string[] = [];
  value.journal.subscribe(event => {
    if (event.kind !== 'board.posted' || event.post.type !== 'claim') return;
    const stored = value.board.getPost(event.post.id);
    assert.deepEqual(stored, event.post, 'post and journal receipt are atomically visible');
    assert.equal(value.kernel.store.get(event.post.item)?.nodes[event.post.author.replace(/^program:/, '')]?.status, 'done');
    receipts.push(event.post.id);
  });
  try {
    const token = value.start();
    await value.kernel.settle();
    const first = value.board.read(token.id, {field: 'proof'});
    assert.equal(first.length, 1);
    assert.equal(first[0].author, 'board/owner');
    assert.equal(first[0].body, 'Completed board/owner');
    assert.equal(first[0].evidence.length, 1);
    assert.equal(value.kernel.store.get(token.id)?.status, 'published');
    value.kernel.returnToken(token, 'human', 'board/owner', 'Recheck the proof', true);
    await value.kernel.settle();
    const claims = value.board.read(token.id, {field: 'proof'});
    assert.equal(claims.length, 2);
    assert.equal(claims[0].status, 'superseded');
    assert.equal(claims[1].status, 'open');
    assert.ok(claims[1].seq > claims[0].seq);
    assert.ok(receipts.length >= 4);
    assert.ok(!value.board.read(token.id).some(post => /stationSessions|runtimeCheckpoint/.test(post.field)));
  } finally {await value.close();}
});

test('D legacy fix becomes an addressed challenge and resumes the owner session with the exact reason', async () => {
  const challengeText = 'The proof must cite the selected page, not the directory.';
  const session = {file: 'work/agent-sessions/fixture-original.json', signature: 'unchanged-fixture-role'};
  let ownerCalls = 0, reviewCalls = 0;
  const value = fixture('fix', async ctx => {
    if (ctx.node.id === 'owner') {
      ownerCalls++;
      if (ownerCalls === 2) {
        assert.deepEqual(ctx.session, session, 'the correction retains the original conversation reference');
        assert.equal(ctx.redo?.reason, challengeText);
        assert.equal(ctx.token.data.proof, 'original', 'original observations remain available for the correction');
      }
      return {ok: true, summary: ownerCalls === 1 ? 'Initial proof' : 'Corrected proof',
        data: {proof: ownerCalls === 1 ? 'original' : 'corrected'}, sessionCheckpoint: {pi: session}};
    }
    if (ctx.node.id === 'check' && ++reviewCalls === 1) return {ok: true, summary: 'Needs correction',
      verdict: {verdict: 'fix', reason: 'Review', fixes: [{station: 'board/owner', fields: ['proof'], problem: challengeText}]}};
    return normal(ctx);
  });
  try {
    const token = value.start();
    await value.kernel.settle();
    assert.equal(ownerCalls, 2);
    assert.equal(value.kernel.store.get(token.id)?.status, 'published');
    const challenges = value.board.read(token.id).filter(post => post.type === 'challenge');
    assert.equal(challenges.length, 1);
    assert.equal(challenges[0].addressee, 'board/owner');
    assert.equal(challenges[0].body, challengeText);
    assert.equal(challenges[0].status, 'resolved');
    assert.equal(value.kernel.store.get(token.id)?.nodes['board/owner'].rounds, 1);
  } finally {await value.close();}
});

test('D a rebuttal opens a room, agrees in round two and holds only the disputed field downstream', async () => {
  let releaseOther!: () => void;
  const otherGate = new Promise<void>(resolve => {releaseOther = resolve;});
  let ownerCalls = 0, checkCalls = 0;
  const turns: string[] = [];
  const value = fixture('consensus', async ctx => {
    if (ctx.node.id === 'other') {await otherGate; return normal(ctx);}
    if (ctx.node.id === 'owner') {
      if (++ownerCalls === 2) {
        const item = value.kernel.store.get(ctx.token.id)!;
        const challenge = value.board.openChallenges(item, ctx.node.key)[0];
        value.board.addPost({item, author: ctx.node.key, type: 'answer', field: 'proof', target: challenge.id,
          body: 'The original proof is supported by the recorded source.', evidence: ['fixture-evidence']});
      }
      return normal(ctx);
    }
    if (ctx.node.id === 'check' && ++checkCalls === 1) return {ok: true, summary: 'Review requests correction',
      verdict: {verdict: 'fix', reason: 'Mismatch', fixes: [{station: 'board/owner', fields: ['proof'], problem: 'Recheck this proof.'}]}};
    return normal(ctx);
  }, {turn: async turn => {
    assert.equal(value.journal.inTransaction, false, 'room model turns run outside the commit');
    assert.equal(turn.mode, 'room');
    assert.deepEqual(turn.budget, {maxTokens: 12000, maxMs: 240000});
    turns.push(`${turn.room!.round}:${turn.node}`);
    releaseOther();
    await tick();
    const item = value.kernel.store.get(turn.itemId)!;
    assert.equal(item.nodes['board/other'].status, 'done', 'independent work advances while the room is open');
    assert.equal(item.nodes['board/check'].status, 'pending', 'the disputed field downstream is held');
    turn.post!({type: 'claim', field: 'proof', body: JSON.stringify({value: turn.room!.round === 1 ? turn.node : 'agreed', reason: 'Source evidence'}), evidence: ['fixture-evidence']});
    return {ok: true, summary: 'One discussion contribution', data: {dialogue: {}}};
  }});
  try {
    const token = value.start();
    await value.kernel.settle();
    assert.deepEqual(turns, ['1:board/owner', '1:board/check', '2:board/owner', '2:board/check']);
    assert.equal(value.board.rooms(token.id)[0].status, 'resolved');
    assert.equal(value.board.rooms(token.id)[0].round, 2);
    assert.equal(value.kernel.store.get(token.id)?.data.proof, 'agreed');
    assert.equal(value.kernel.store.get(token.id)?.status, 'published');
    assert.equal(value.kernel.store.get(token.id)?.roomHolds, undefined);
    assert.equal(checkCalls, 2);
  } finally {releaseOther(); await value.close();}
});

test('D three inconclusive rounds reject two fabricated judge quotes and park the item', async () => {
  let judges = 0;
  const value = fixture('judge-rejection', normal, {turn: async turn => {
    if (turn.mode === 'room') {
      turn.post!({type: 'claim', field: 'proof', body: JSON.stringify({value: turn.node, reason: 'Disagreement'}), evidence: ['fixture-evidence']});
      return {ok: true, summary: 'Contributed', data: {dialogue: {}}};
    }
    assert.equal(turn.mode, 'judge');
    judges++;
    if (judges === 2) assert.ok(turn.repairReason, 'the second judge request receives the exact failed validation');
    return {ok: true, summary: 'Unsupported ruling', data: {dialogue: {value: 'invented', quote: 'This was never in the source.', evidence: ['fixture-evidence']}}};
  }});
  try {
    const token = value.start();
    await value.kernel.settle();
    value.kernel.returnToken(token, 'human', 'board/check', 'Open dispute before continuing', true);
    value.kernel.openDiscussion(token.id, 'proof', 'Disputed proof');
    await value.kernel.settle();
    assert.equal(judges, 2);
    assert.equal(value.board.rooms(token.id)[0].status, 'parked');
    assert.equal(value.kernel.store.get(token.id)?.status, 'parked');
    assert.equal(value.kernel.store.get(token.id)?.parked?.code, 'room_unresolved');
    assert.equal(value.kernel.store.get(token.id)?.data.proof, 'original', 'invalid quotations must never write the proposed result');
  } finally {await value.close();}
});

test('D questions release the only model worker and resume the same attempt after the answer', async () => {
  let checked = false;
  const value = fixture('question-lease', async ctx => {
    if (ctx.node.id !== 'check') return normal(ctx);
    const item = value.kernel.store.get(ctx.token.id)!;
    const question = value.board.addPost({item, author: ctx.node.key, type: 'question', field: 'proof',
      addressee: 'board/owner', body: 'Which observation supports this proof?'});
    assert.ok(ctx.waitForRoom);
    const answer = await ctx.waitForRoom(() => value.collaboration.answer(question, ctx.signal));
    assert.equal(answer.type, 'answer');
    assert.equal(answer.target, question.id);
    assert.equal(value.kernel.store.get(item.id)?.nodes[ctx.node.key].status, 'running');
    assert.equal(value.kernel.store.get(item.id)?.nodes[ctx.node.key].lastAttempt, ctx.attempt);
    assert.equal(value.broker.used.model, 1);
    checked = true;
    return normal(ctx);
  }, {modelWorkers: 1, turn: async turn => {
    assert.equal(turn.mode, 'answer');
    assert.deepEqual(turn.budget, {maxTokens: 8000, maxMs: 180000});
    assert.equal(value.kernel.store.get(turn.itemId)?.nodes['board/check'].waitingFor, 'room');
    assert.equal(value.broker.used.model, 0, 'the question releases its lifecycle worker before answer acquisition');
    const lease = await value.broker.acquire('model', {review: true, signal: turn.signal, timeoutMs: 100});
    assert.ok(lease, 'one worker must be sufficient to answer a paused question');
    try {
      turn.post!({type: 'answer', field: 'proof', target: turn.question!.id, body: 'The recorded source supports it.', evidence: ['fixture-evidence']});
    } finally {lease.release();}
    return {ok: true, summary: 'Answered', data: {dialogue: {}}};
  }});
  try {
    const token = value.start();
    await value.kernel.settle();
    assert.equal(checked, true);
    assert.equal(value.kernel.store.get(token.id)?.status, 'published');
    assert.equal(value.kernel.store.attempts(token.id).filter(attempt => attempt.node === 'board/check').length, 1);
  } finally {await value.close();}
});

test('D a node gets at most two answer turns and invalid board authors and targets are rejected', async () => {
  let turns = 0;
  const value = fixture('question-limit', normal, {turn: async turn => {
    turns++;
    turn.post!({type: 'answer', field: 'proof', target: turn.question!.id, body: 'The source contains the observation.'});
    return {ok: true, summary: 'Answered', data: {dialogue: {}}};
  }});
  try {
    const token = value.start();
    await value.kernel.settle();
    const item = value.kernel.store.get(token.id)!;
    assert.throws(() => value.board.addPost({item, author: 'board/seed', type: 'challenge', field: 'proof', addressee: 'board/owner', body: 'A program cannot challenge.'}));
    assert.throws(() => value.board.addPost({item, author: 'board/check', type: 'challenge', field: 'proof', addressee: 'board/other', body: 'Wrong owner.'}));
    let question!: BoardPost;
    for (let index = 0; index < 2; index++) {
      question = value.board.addPost({item, author: 'board/check', type: 'question', field: 'proof', addressee: 'board/owner', body: `Question ${index + 1}`});
      assert.throws(() => value.board.addPost({item, author: 'board/other', type: 'answer', field: 'proof', target: question.id, body: 'Not addressed to me.'}));
      await value.collaboration.answer(question);
    }
    assert.equal(turns, 2);
    await assert.rejects(async () => {
      question = value.board.addPost({item, author: 'board/check', type: 'question', field: 'proof', addressee: 'board/owner', body: 'One question too many'});
      await value.collaboration.answer(question);
    }, /本节点答疑次数已用完，请依据现有证据判断/);
    assert.equal(turns, 2, 'the limit must not spend a third model turn');
    const sharedField = new BoardStore(value.journal, value.compiled, {
      'board/owner': {outputKey: 'proof'}, 'board/check': {outputKey: 'proof'},
    });
    assert.deepEqual(sharedField.owners(item, 'proof'), ['board/owner', 'board/check']);
    const otherOwner = new Collaboration(sharedField, {...value.host,
      owner: (id, field) => sharedField.owners(id, field)[0],
      runTurn: async turn => {
        assert.equal(turn.node, 'board/check');
        turn.post!({type: 'answer', field: 'proof', target: turn.question!.id, body: 'This second owner has its own evidence.'});
        return {ok: true, summary: 'Second owner answered', data: {dialogue: {}}};
      }});
    const addressed = sharedField.addPost({item, author: 'board/owner', type: 'question', field: 'proof',
      addressee: 'board/check', body: 'Explain the evidence you added to this shared field.'});
    const answer = await otherOwner.answer(addressed);
    assert.equal(answer.author, 'board/check', 'a shared top-level field permits questions to every declared owner');
  } finally {await value.close();}
});

test('D a failed automatic claim rolls back the completed attempt, item and board together', async t => {
  const value = fixture('claim-rollback', normal);
  const original = value.board.autoClaim.bind(value.board);
  t.mock.method(value.board, 'autoClaim', (...args: Parameters<BoardStore['autoClaim']>) => {
    const posts = original(...args);
    if (args[1] === 'board/owner') throw new Error('fixture claim commit failure');
    return posts;
  });
  try {
    const token = value.start();
    await value.kernel.settle();
    assert.deepEqual(value.board.read(token.id, {field: 'proof'}), []);
    const attempt = value.kernel.store.attempts(token.id).find(row => row.node === 'board/owner');
    assert.ok(attempt);
    assert.equal(attempt.status, 'running', 'the failed transaction cannot leave an accepted attempt row');
    assert.equal(value.kernel.store.get(token.id)?.nodes['board/owner'].status, 'running');
    assert.equal([...value.journal.read()].some(event => event.kind === 'attempt.finished' && event.attempt === attempt.id), false);
    assert.equal(value.kernel.store.get(token.id)?.data.proof, undefined);
  } finally {await value.close();}
});

for (const postedButUnfinished of [false, true]) test(`D restarting a room preserves its posts with submit_turn ${postedButUnfinished ? 'interrupted' : 'completed'}`, async () => {
  let entered!: () => void;
  const waiting = new Promise<void>(resolve => {entered = resolve;});
  const value = fixture(`room-restart-${postedButUnfinished}`, normal, {turn: async turn => {
    if (turn.node === 'board/owner') {
      turn.post!({type: 'claim', field: 'proof', body: JSON.stringify({value: 'recovered', reason: 'First durable turn'}), evidence: ['fixture-evidence']});
      if (!postedButUnfinished) return {ok: true, summary: 'First turn committed', data: {dialogue: {}}};
    }
    entered();
    await new Promise<void>((_resolve, reject) => turn.signal!.addEventListener('abort', () => reject(turn.signal!.reason), {once: true}));
    throw new Error('An interrupted turn must not finish');
  }});
  let recovered: Kernel | undefined;
  try {
    const token = value.start();
    await value.kernel.settle();
    value.kernel.returnToken(token, 'human', 'board/check', 'Discuss before continuing', true);
    const room = value.kernel.openDiscussion(token.id, 'proof', 'Recover this discussion');
    await waiting;
    await value.kernel.close();
    assert.equal(value.board.getRoom(room.id)?.status, 'open');
    assert.equal(value.kernel.store.get(token.id)?.status, 'active');
    assert.equal(value.board.roomPosts(room.id).length, 1);
    assert.equal(value.board.roomPosts(room.id)[0].status, postedButUnfinished ? 'open' : 'resolved');
    recovered = new Kernel(value.compiled, value.journal, value.broker, {}, () => normal);
    const board = new BoardStore(value.journal, value.compiled, {'board/owner': {outputKey: 'proof'}});
    const resumed: string[] = [];
    const host: CollaborationHost = {...value.host,
      getItem: id => recovered!.store.get(id),
      applyResolution: (id, field, result, owner, roomId) => recovered!.applyRoomResolution(id, field, result, owner, roomId),
      park: (id, node, reason, code) => recovered!.parkCollaboration(id, node, reason, code),
      runTurn: async turn => {
        resumed.push(turn.node);
        if (turn.existingPost) {
          assert.equal(turn.node, 'board/owner');
          assert.equal(turn.existingPost.id, board.roomPosts(room.id)[0].id);
          assert.match(turn.prompt, /不要重复发言.*submit_turn/);
          assert.throws(() => turn.post!({type: 'claim', field: 'proof', body: JSON.stringify({value: 'recovered', reason: 'Duplicate'}), evidence: ['fixture-evidence']}), /只能发表一条/);
        } else turn.post!({type: 'claim', field: 'proof', body: JSON.stringify({value: 'recovered', reason: 'Resume from saved discussion'}), evidence: ['fixture-evidence']});
        return {ok: true, summary: 'Recovered turn', data: {dialogue: {}}};
      }};
    const collaboration = new Collaboration(board, host);
    recovered.configureCollaboration({board,
      openRoom: () => {throw new Error('Recovery must reuse the original room');},
      runRoom: (current, signal) => collaboration.runRoom(current, signal),
      answer: (question, signal) => collaboration.answer(question, signal)});
    recovered.recover();
    assert.equal(recovered.paused, true);
    recovered.resume();
    await recovered.settle();
    assert.deepEqual(resumed, postedButUnfinished ? ['board/owner', 'board/check'] : ['board/check']);
    assert.equal(board.roomPosts(room.id).length, 2);
    assert.equal(board.getRoom(room.id)?.status, 'resolved');
    assert.equal(recovered.store.get(token.id)?.data.proof, 'recovered');
    assert.equal(recovered.store.get(token.id)?.status, 'published');
  } finally {await recovered?.close(); await value.close();}
});

test('D kind disagreement enters a discussion and adopts its result before routing past the arbiter', async () => {
  const pack: Pack = {...fixturePack(), lines: [line({id: 'board', name: 'Kind room', layer: 3, priority: 'mid', wired: true,
    blurb: 'A disagreement must enter the field discussion', stations: [
      ...['seed', 'kind-join', 'catalog'].map(id => station({id, name: id, kind: 'program', role: 'process', resource: 'none', accept: ['Preserve the fixture route']})),
      ...['classify', 'classify-review', 'arbiter'].map(id => station({id, name: id, kind: 'agent', role: 'process', resource: 'model', accept: ['Classify with evidence']})),
      station({id: 'published', name: 'Published', kind: 'store', role: 'store'}),
    ], edges: [['seed', 'classify'], ['seed', 'classify-review'], ['classify', 'kind-join'], ['classify-review', 'kind-join'],
      ['kind-join', 'catalog', 'agree'], ['kind-join', 'arbiter', 'disagree'], ['arbiter', 'catalog'], ['catalog', 'published']]})],
    conditions: {agree: data => data.kindAgreed === true, disagree: data => data.kindAgreed === false}};
  const compiled = compile([pack]);
  assert.deepEqual(compiled.issues, []);
  const journal = new Journal(path.join(directory, 'kind-discussion.db'));
  let arbiterCalls = 0, roomCalls = 0;
  const kernel = new Kernel(compiled, journal, new Broker({model: 4}, 0), pack.conditions, () => async ctx => {
    if (ctx.node.id === 'arbiter') arbiterCalls++;
    return {ok: true, summary: ctx.node.key, data: ctx.node.id === 'kind-join' ? {kindAgreed: false} : {[ctx.node.id]: true}};
  });
  const board = new BoardStore(journal, compiled);
  kernel.configureCollaboration({board,
    openRoom: (item, field, topic) => board.createRoom({item, field, topic,
      participants: ['board/classify', 'board/classify-review'], judge: 'board/arbiter'}),
    runRoom: async room => {
      roomCalls++;
      assert.equal(journal.inTransaction, false);
      assert.equal(kernel.store.get(room.item)?.nodes['board/arbiter'].status, 'pending');
      journal.atomic(() => {
        board.closeRoom(room.id, {status: 'resolved', value: 'gallery'});
        kernel.applyRoomResolution(room.item, 'kind', 'gallery', 'board/kind-join', room.id);
      });
    }, answer: async () => {throw new Error('No question in kind-routing fixture');}});
  try {
    kernel.start('Kind disagreement');
    const token = kernel.create('board/seed', {item: 'kind fixture', url: '', source: 'fixture'});
    await kernel.settle();
    assert.equal(roomCalls, 1);
    assert.equal(arbiterCalls, 0, 'the normal graph arbiter must not run alongside the room judge');
    assert.equal(kernel.store.get(token.id)?.data.kind, 'gallery');
    assert.equal(kernel.store.get(token.id)?.data.kindAgreed, true);
    assert.equal(kernel.store.get(token.id)?.nodes['board/arbiter'].status, 'skipped');
    assert.equal(kernel.store.get(token.id)?.status, 'published');
  } finally {await kernel.close(); journal.close();}
});

test('D returned challenge text reaches the real Pi request together with the original submit history', {timeout: 20000}, async () => {
  const dir = path.join(directory, 'pi-challenge');
  fs.mkdirSync(dir);
  const previousDirectory = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = dir;
  const requests: Record<string, unknown>[] = [];
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push(JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>);
    const proof = requests.length === 1 ? 'original-observed-proof-marker' : 'corrected';
    response.writeHead(200, {'content-type': 'text/event-stream'});
    for (const part of [
      {choices: [{index: 0, delta: {role: 'assistant', tool_calls: [{index: 0, id: `claim-${requests.length}`, type: 'function',
        function: {name: 'submit', arguments: JSON.stringify({proof})}}]}, finish_reason: null}]},
      {choices: [{index: 0, delta: {}, finish_reason: 'tool_calls'}], usage: {prompt_tokens: 10, completion_tokens: 5, total_tokens: 15}},
    ]) response.write(`data: ${JSON.stringify({id: 'board-fixture', model: 'board-model', ...part})}\n\n`);
    response.end('data: [DONE]\n\n');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as {port: number}).port;
  fs.writeFileSync(path.join(dir, 'auth.json'), JSON.stringify({board: {type: 'api_key', key: 'local-fixture-only'}}));
  fs.writeFileSync(path.join(dir, 'models.json'), JSON.stringify({providers: {board: {api: 'openai-completions',
    baseUrl: `http://127.0.0.1:${port}/v1`, models: [{id: 'board-model', input: ['text']}]}}}));
  const definition: AgentStationDef<{proof: string}> = {
    agent: {adapter: 'pi', provider: 'board', model: 'board-model'},
    role: {station: 'board/owner', path: 'fixture/ROLE.md', revision: 'stable-proof-role', content: 'Verify the proof.'},
    system: 'Submit the proof supported by the selected page.',
    schema: Type.Object({proof: Type.String()}, {additionalProperties: false}),
    input: () => ({text: 'Original board input remains part of the conversation.'}),
    services: {docs: () => ({dir, envelope: () => ({text: 'Fixture proof identity', sizes: {role: 0, project: 0, context: 0, caseFile: 0}})}) as unknown as Docs,
      toolbox: () => ({names: () => [], help: () => ({ok: true}), call: async () => {throw new Error('This model fixture only submits');}}) as unknown as Toolbox},
    after: output => ({ok: true, summary: 'Verified proof', data: output}),
  };
  let reviewCalls = 0;
  const reasons = ['Cite the selected page.', 'Keep the earlier observation and add its source.'];
  const value = fixture('pi-challenge', async ctx => {
    if (ctx.node.id === 'owner') return runAgentStation(definition, ctx);
    if (ctx.node.id === 'check' && ++reviewCalls === 1) return {ok: true, summary: 'Two concrete corrections',
      verdict: {verdict: 'fix', reason: 'Review', fixes: reasons.map(problem => ({station: 'board/owner', fields: ['proof'], problem}))}};
    return normal(ctx);
  });
  try {
    const token = value.start();
    await value.kernel.settle();
    assert.equal(value.kernel.store.get(token.id)?.status, 'published', JSON.stringify(value.kernel.store.attempts(token.id)));
    assert.equal(requests.length, 2);
    const messages = requests[1].messages as {role: string; content: unknown}[];
    const requestText = JSON.stringify(messages);
    assert.ok(requestText.includes('original-observed-proof-marker'), 'the actual request retains the first submit, not merely its file reference');
    assert.ok(requestText.includes('审查退回：' + reasons.join('\\n')));
    assert.ok(requestText.includes('Original board input remains part of the conversation.'));
    assert.equal(value.board.read(token.id).filter(post => post.type === 'challenge' && post.status === 'resolved').length, 2);
  } finally {
    await value.close();
    await closeModelTransport();
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    if (previousDirectory === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDirectory;
  }
});
