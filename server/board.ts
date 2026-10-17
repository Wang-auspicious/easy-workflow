import {randomUUID} from 'node:crypto';
import {isDeepStrictEqual} from 'node:util';
import type {BoardPost, BoardPostInput, BoardPostStatus, Room, RoomOutcome} from '../shared/board.ts';
import {deserializeSnapshot} from '../shared/project.ts';
import type {CompiledFactory, CompiledNode} from '../shared/types.ts';
import {ControlError} from './errors.ts';
import type {Journal} from './journal.ts';
import {topologicalOrder, validateItem, type ItemState} from './kernel/item.ts';
import type {Fix} from './runtime.ts';

type Item = ItemState | string;
type Contracts = Record<string, {outputKey?: string}>;
export interface BoardWrite extends BoardPostInput {item: Item; author: string}
export interface BoardRead {room?: string; round?: number; field?: string; openOnly?: boolean; limit?: number}
export interface NewRoom {
  item: Item;
  field: string;
  topic: string;
  participants: string[];
  judge: string;
  maxRounds?: number;
}
export interface CloseRoom extends RoomOutcome {status: Exclude<Room['status'], 'open'>}

interface PostRow extends Omit<BoardPost, 'target' | 'addressee' | 'room' | 'evidence'> {
  target: string | null;
  addressee: string | null;
  room: string | null;
  evidence: string;
}
interface RoomRow {
  id: string; item: string; field: string; topic: string; participants: string; judge: string;
  max_rounds: number; round: number; status: Room['status']; opened_at: number;
  closed_at: number | null; outcome: string | null;
}

const postTypes = new Set(['claim', 'challenge', 'answer', 'question', 'evidence', 'resolve', 'note']);
const unsafeKeys = new Set(['__proto__', 'prototype', 'constructor']);
const hostKeys = new Set(['stationSessions', 'closedStationSessions', 'runtimeCheckpoint']);
const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
function text(value: unknown, label: string, max = Number.MAX_SAFE_INTEGER): asserts value is string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ControlError(400, 'BOARD_INVALID', `${label} must be a nonempty string of at most ${max} characters`);
  }
}
function fieldName(value: unknown): asserts value is string {
  text(value, 'field');
  if (value.split('.').some(part => !part || unsafeKeys.has(part))) {
    throw new ControlError(400, 'BOARD_INVALID_FIELD', 'Invalid board field path');
  }
}
function itemId(item: Item): string {
  const id = typeof item === 'string' ? item : item?.id;
  text(id, 'item');
  return id;
}

/** Board rows and their events share the journal connection and commit together. */
export class BoardStore {
  readonly journal: Journal;
  private readonly nodes: Map<string, CompiledNode>;
  private readonly order: string[];
  private readonly declared = new Map<string, string[]>();
  private readonly fields = new Map<string, string[]>();
  private readonly hasPosts: boolean;
  private readonly hasRooms: boolean;

  constructor(journal: Journal, compiled: CompiledFactory, contracts: Contracts = {}, historicalOutputKeys: Record<string, string[]> = {}) {
    this.journal = journal;
    this.nodes = new Map(compiled.nodes.map(node => [node.key, node]));
    this.order = topologicalOrder(compiled);
    if (!journal.readOnly) journal.database.exec(`
      CREATE TABLE IF NOT EXISTS board_posts (
        id TEXT PRIMARY KEY, item TEXT NOT NULL, seq INTEGER NOT NULL, at INTEGER NOT NULL,
        author TEXT NOT NULL, type TEXT NOT NULL, field TEXT NOT NULL, target TEXT,
        addressee TEXT, room TEXT, round INTEGER NOT NULL DEFAULT 0,
        body TEXT NOT NULL, evidence TEXT NOT NULL, status TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS board_item ON board_posts(item, seq);
      CREATE TABLE IF NOT EXISTS rooms (
        id TEXT PRIMARY KEY, item TEXT NOT NULL, field TEXT NOT NULL, topic TEXT NOT NULL,
        participants TEXT NOT NULL, judge TEXT NOT NULL, max_rounds INTEGER NOT NULL DEFAULT 3,
        round INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL,
        opened_at INTEGER NOT NULL, closed_at INTEGER, outcome TEXT
      );
    `);
    const exists = journal.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    this.hasPosts = Boolean(exists.get('board_posts'));
    this.hasRooms = Boolean(exists.get('rooms'));
    const latest = exists.get('attempts') ? journal.database.prepare(
      `SELECT body FROM attempts WHERE node = ? AND status = 'ok' AND json_extract(body, '$.dialogue') IS NULL
        ORDER BY ended_at DESC, started_at DESC, rowid DESC LIMIT 1`
    ) : undefined;
    for (const key of this.order) {
      const outputKey = contracts[key]?.outputKey;
      if (outputKey !== undefined) {
        fieldName(outputKey);
        const fields = [outputKey.split('.')[0]];
        this.declared.set(key, fields);
        this.fields.set(key, fields);
        continue;
      }
      const row = latest?.get(key) as {body: string} | undefined;
      if (!row) { this.fields.set(key, this.outputKeys(historicalOutputKeys[key] ?? [])); continue; }
      const body = deserializeSnapshot(row.body);
      // C attempts predate outputKeys; their saved output contains the same keys.
      const keys = record(body) && Array.isArray(body.outputKeys) ? body.outputKeys :
        record(body) && record(body.output) ? Object.keys(body.output) : [];
      this.fields.set(key, this.outputKeys(keys));
    }
  }

  ownership(): Record<string, string[]> {
    const result = new Map<string, string[]>();
    for (const key of this.order) for (const field of this.fields.get(key) ?? []) {
      const owners = result.get(field) ?? [];
      owners.push(key);
      result.set(field, owners);
    }
    return Object.fromEntries(result);
  }

  owners(item: Item, field: string): string[] {
    fieldName(field);
    const state = this.item(item);
    const top = field.split('.')[0];
    return this.order.filter(key => Object.hasOwn(state.nodes, key) && this.fields.get(key)?.includes(top));
  }

  read(item: Item, options: BoardRead = {}): BoardPost[] {
    const id = itemId(item);
    if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) {
      throw new ControlError(400, 'BOARD_INVALID', 'Invalid board read limit');
    }
    if (options.openOnly !== undefined && typeof options.openOnly !== 'boolean') {
      throw new ControlError(400, 'BOARD_INVALID', 'Invalid openOnly filter');
    }
    const conditions = ['item = ?'];
    const params: (string | number)[] = [id];
    if (options.field !== undefined) { fieldName(options.field); conditions.push('field = ?'); params.push(options.field); }
    if (options.room !== undefined) { text(options.room, 'room'); conditions.push('room = ?'); params.push(options.room); }
    if (options.round !== undefined) {
      if (!Number.isSafeInteger(options.round) || options.round < 0) throw new ControlError(400, 'BOARD_INVALID', 'Invalid round');
      conditions.push('round = ?'); params.push(options.round);
    }
    if (options.openOnly) conditions.push("status = 'open'");
    if (!this.hasPosts) return [];
    const rows = this.journal.database.prepare(
      `SELECT * FROM board_posts WHERE ${conditions.join(' AND ')} ORDER BY seq DESC LIMIT ?`
    ).all(...params, Math.min(options.limit ?? 40, 40)) as unknown as PostRow[];
    return rows.reverse().map(row => this.decodePost(row));
  }

  getPost(id: string): BoardPost | undefined {
    if (!this.hasPosts) return undefined;
    const row = this.journal.database.prepare('SELECT * FROM board_posts WHERE id = ?').get(id) as PostRow | undefined;
    return row && this.decodePost(row);
  }

  answerTo(target: string): BoardPost | undefined {
    if (!this.hasPosts) return undefined;
    const row = this.journal.database.prepare(
      "SELECT * FROM board_posts WHERE target = ? AND type = 'answer' ORDER BY seq DESC LIMIT 1"
    ).get(target) as PostRow | undefined;
    return row && this.decodePost(row);
  }

  addPost(input: BoardWrite): BoardPost {
    this.writable();
    let result!: BoardPost;
    this.journal.atomic(() => { result = this.add(input); });
    return result;
  }

  autoClaim(item: ItemState, nodeKey: string, summary: string, output: Record<string, unknown>, evidence: string[]): BoardPost[] {
    this.writable();
    if (!record(output) || typeof summary !== 'string') throw new ControlError(400, 'BOARD_INVALID', 'Invalid successful output');
    this.node(item, nodeKey);
    const author = this.author(item, nodeKey);
    const fields = this.declared.get(nodeKey) ?? this.outputKeys(Object.keys(output));
    const posts: BoardPost[] = [];
    this.journal.atomic(() => {
      for (const field of fields) {
        const rows = this.journal.database.prepare(
          "SELECT * FROM board_posts WHERE item = ? AND field = ? AND type = 'claim' AND room IS NULL AND status != 'superseded' ORDER BY seq"
        ).all(item.id, field) as unknown as PostRow[];
        for (const row of rows) this.status(this.decodePost(row), 'superseded');
        posts.push(this.insert({item: item.id, author, type: 'claim', field, body: summary.slice(0, 300),
          evidence: this.evidence(evidence), round: 0}));
      }
      this.journal.afterCommit(() => { this.fields.set(nodeKey, fields); });
    });
    return posts;
  }

  legacyFixes(item: ItemState, reviewer: string, fixes: Fix[]): BoardPost[] {
    this.writable();
    const posts: BoardPost[] = [];
    this.journal.atomic(() => {
      for (const fix of fixes) {
        if (!Array.isArray(fix.fields) || !fix.fields.length) throw new ControlError(400, 'BOARD_INVALID', 'A fix must name a field');
        const addressee = this.resolveNode(item, fix.station, this.nodes.get(reviewer)?.line);
        posts.push(this.add({item, author: reviewer, type: 'challenge', addressee, field: fix.fields[0], body: fix.problem}));
      }
    });
    return posts;
  }

  openChallenges(item: Item, addressee?: string): BoardPost[] {
    if (!this.hasPosts) return [];
    const rows = (addressee === undefined
      ? this.journal.database.prepare("SELECT * FROM board_posts WHERE item = ? AND type = 'challenge' AND status = 'open' ORDER BY seq").all(itemId(item))
      : this.journal.database.prepare("SELECT * FROM board_posts WHERE item = ? AND type = 'challenge' AND status = 'open' AND addressee = ? ORDER BY seq").all(itemId(item), addressee)
    ) as unknown as PostRow[];
    const position = new Map(this.order.map((key, index) => [key, index]));
    return rows.map(row => this.decodePost(row)).sort((left, right) =>
      (position.get(left.addressee ?? '') ?? Infinity) - (position.get(right.addressee ?? '') ?? Infinity) || left.seq - right.seq);
  }

  answeredChallenges(item: Item, nodeKey: string): BoardPost[] {
    const author = this.author(this.item(item), nodeKey);
    return this.openChallenges(item, nodeKey).filter(post => Boolean(this.journal.database.prepare(
      "SELECT 1 FROM board_posts WHERE target = ? AND type = 'answer' AND author = ? LIMIT 1"
    ).get(post.id, author)));
  }

  resolveChallenges(ids: string[]): BoardPost[] {
    this.writable();
    const posts = [...new Set(ids)].map(id => {
      const post = this.getPost(id);
      if (!post || post.type !== 'challenge') throw new ControlError(400, 'BOARD_INVALID_TARGET', 'Unknown challenge');
      return post;
    });
    const result: BoardPost[] = [];
    this.journal.atomic(() => {
      for (const post of posts) result.push(post.status === 'open' ? this.status(post, 'resolved') : post);
    });
    return result;
  }

  /** Durable count includes resolved questions and survives process restarts. */
  askQuota(item: Item, nodeKey: string): number {
    if (!this.hasPosts) return 0;
    const row = this.journal.database.prepare(
      "SELECT COUNT(*) count FROM board_posts WHERE item = ? AND type = 'question' AND addressee = ?"
    ).get(itemId(item), nodeKey) as {count: number};
    return row.count;
  }

  getRoom(id: string): Room | undefined {
    if (!this.hasRooms) return undefined;
    const row = this.journal.database.prepare('SELECT * FROM rooms WHERE id = ?').get(id) as RoomRow | undefined;
    return row && this.decodeRoom(row);
  }

  rooms(item?: string, status?: Room['status']): Room[] {
    if (!this.hasRooms) return [];
    const conditions: string[] = [];
    const params: string[] = [];
    if (item !== undefined) { conditions.push('item = ?'); params.push(item); }
    if (status !== undefined) { conditions.push('status = ?'); params.push(status); }
    const rows = this.journal.database.prepare(
      `SELECT * FROM rooms${conditions.length ? ` WHERE ${conditions.join(' AND ')}` : ''} ORDER BY opened_at, id`
    ).all(...params) as unknown as RoomRow[];
    return rows.map(row => this.decodeRoom(row));
  }

  roomPosts(id: string): BoardPost[] {
    if (!this.hasPosts) return [];
    const rows = this.journal.database.prepare('SELECT * FROM board_posts WHERE room = ? ORDER BY seq').all(id) as unknown as PostRow[];
    return rows.map(row => this.decodePost(row));
  }

  /** Posting and submit_turn are separate receipts; recovery must not infer the latter. */
  completeTurn(id: string): BoardPost {
    this.writable();
    let result!: BoardPost;
    this.journal.atomic(() => {
      const post = this.getPost(id);
      if (!post?.room) throw new ControlError(400, 'ROOM_POST', 'Only a room post can complete a turn');
      if (post.status === 'resolved') { result = post; return; }
      const room = this.requireRoom(post.room);
      if (room.status !== 'open' || room.round !== post.round || post.status !== 'open') {
        throw new ControlError(409, 'ROOM_ROUND', 'This room turn is no longer open');
      }
      result = this.status(post, 'resolved');
    });
    return result;
  }

  createRoom(input: NewRoom): Room {
    this.writable();
    const item = this.item(input.item);
    fieldName(input.field);
    text(input.topic, 'topic', 2000);
    if (!Array.isArray(input.participants) || input.participants.length < 2 || input.participants.length > 3 ||
        new Set(input.participants).size !== input.participants.length) {
      throw new ControlError(400, 'ROOM_PARTICIPANTS', 'A room requires two or three distinct participants');
    }
    for (const key of input.participants) this.node(item, key);
    text(input.judge, 'judge');
    if (input.judge.startsWith('program:')) text(input.judge.slice(8), 'program judge');
    else this.node(item, input.judge);
    const maxRounds = input.maxRounds ?? 3;
    if (!Number.isSafeInteger(maxRounds) || maxRounds < 1 || maxRounds > 3) {
      throw new ControlError(400, 'ROOM_ROUNDS', 'A room permits at most three rounds');
    }
    let result!: Room;
    this.journal.atomic(() => {
      const previous = this.rooms(item.id, 'open').find(room => room.field === input.field);
      if (previous) { result = previous; return; }
      result = {id: randomUUID(), item: item.id, field: input.field, topic: input.topic,
        participants: [...input.participants], judge: input.judge, maxRounds, round: 1, status: 'open', openedAt: Date.now()};
      this.writeRoom(result, 'room.opened');
    });
    return result;
  }

  advanceRoom(id: string): Room {
    this.writable();
    let result!: Room;
    this.journal.atomic(() => {
      const room = this.requireRoom(id);
      if (room.status !== 'open') throw new ControlError(409, 'ROOM_CLOSED', 'The room is closed');
      if (room.round >= room.maxRounds) throw new ControlError(409, 'ROOM_ROUNDS', 'The room must now go to its judge');
      const authors = new Set(this.roomPosts(id).filter(post => post.round === room.round && post.status === 'resolved')
        .map(post => post.author.replace(/^program:/, '')));
      if (room.participants.some(key => !authors.has(key))) throw new ControlError(409, 'ROOM_INCOMPLETE', 'Every participant must speak before the next round');
      result = {...room, round: room.round + 1};
      this.writeRoom(result, 'room.round');
    });
    return result;
  }

  closeRoom(id: string, outcome: CloseRoom): Room {
    this.writable();
    if (!['resolved', 'judged', 'parked'].includes(outcome.status) ||
        outcome.status !== 'parked' && (!Object.hasOwn(outcome, 'value') || outcome.value === undefined)) {
      throw new ControlError(400, 'ROOM_OUTCOME', 'A resolved or judged room requires a value');
    }
    if (outcome.reason !== undefined) text(outcome.reason, 'reason');
    let body: RoomOutcome;
    try {
      body = JSON.parse(JSON.stringify({...(Object.hasOwn(outcome, 'value') ? {value: outcome.value} : {}),
        ...(outcome.reason === undefined ? {} : {reason: outcome.reason})}));
    } catch { throw new ControlError(400, 'ROOM_OUTCOME', 'The room outcome must be JSON'); }
    let result!: Room;
    this.journal.atomic(() => {
      const room = this.requireRoom(id);
      if (room.status !== 'open') {
        if (room.status === outcome.status && isDeepStrictEqual(room.outcome, body)) { result = room; return; }
        throw new ControlError(409, 'ROOM_CLOSED', 'The room is already closed');
      }
      result = {...room, status: outcome.status, closedAt: Date.now(), outcome: body};
      this.writeRoom(result, 'room.closed');
    });
    return result;
  }

  private add(input: BoardWrite): BoardPost {
    const item = this.item(input.item);
    const author = this.author(item, input.author);
    const nodeKey = author.replace(/^program:/, '');
    fieldName(input.field);
    text(input.body, 'body', 2000);
    if (!postTypes.has(input.type) || input.type === 'resolve' || input.type === 'claim' && !input.room) {
      throw new ControlError(403, 'BOARD_POST_TYPE', 'Only automatic completion or a room participant may post a claim');
    }
    if (input.type === 'challenge' && !['agent', 'review'].includes(this.nodes.get(nodeKey)?.kind ?? '')) {
      throw new ControlError(403, 'BOARD_AUTHOR', 'Only agent and review nodes may challenge');
    }
    if (input.addressee !== undefined && !this.owners(item, input.field).includes(input.addressee)) {
      throw new ControlError(403, 'BOARD_OWNER', 'The addressee must own this field within the item');
    }
    if ((input.type === 'challenge' || input.type === 'question') && input.addressee === undefined) {
      throw new ControlError(400, 'BOARD_ADDRESSEE', 'A challenge or question requires an addressee');
    }
    let target: BoardPost | undefined;
    if (input.target !== undefined) {
      text(input.target, 'target');
      target = this.getPost(input.target);
      if (!target || target.item !== item.id || target.field !== input.field) {
        throw new ControlError(400, 'BOARD_INVALID_TARGET', 'The target must belong to this item and field');
      }
    }
    const roomAnswer = input.room !== undefined && target?.room === input.room &&
      target.type === 'challenge' && target.status === 'resolved';
    if (input.type === 'answer' && (!target || !['challenge', 'question'].includes(target.type) ||
        target.addressee !== nodeKey || target.room !== input.room || target.status !== 'open' && !roomAnswer)) {
      throw new ControlError(403, 'BOARD_ANSWER_TARGET', 'An answer must target an open challenge or question addressed to its author');
    }
    let round = 0;
    if (input.room !== undefined) {
      text(input.room, 'room');
      const room = this.requireRoom(input.room);
      if (room.item !== item.id || room.field !== input.field || room.status !== 'open' || !room.participants.includes(nodeKey)) {
        throw new ControlError(403, 'ROOM_AUTHOR', 'Only participants may speak in this open room and field');
      }
      if (!['claim', 'challenge', 'answer'].includes(input.type)) throw new ControlError(400, 'ROOM_POST_TYPE', 'A room turn requires a claim, challenge or answer');
      if (!this.evidence(input.evidence ?? []).length) throw new ControlError(400, 'ROOM_EVIDENCE', 'Room turns require evidence identifiers');
      if (input.round !== undefined && input.round !== room.round) throw new ControlError(409, 'ROOM_ROUND', 'The room has moved to another round');
      round = room.round;
      if (this.journal.database.prepare('SELECT 1 FROM board_posts WHERE room = ? AND round = ? AND author = ? LIMIT 1').get(room.id, round, author)) {
        throw new ControlError(409, 'ROOM_ALREADY_SPOKEN', 'Each participant may post exactly once per round');
      }
      if (input.type === 'claim') {
        let claim: unknown;
        try { claim = JSON.parse(input.body); } catch { throw new ControlError(400, 'ROOM_CLAIM', 'Room claims must encode {value,reason} as JSON'); }
        if (!record(claim) || !Object.hasOwn(claim, 'value') || typeof claim.reason !== 'string' ||
            Object.keys(claim).some(key => key !== 'value' && key !== 'reason')) {
          throw new ControlError(400, 'ROOM_CLAIM', 'Room claims must encode {value,reason} as JSON');
        }
      }
    } else if (input.round !== undefined && input.round !== 0) {
      throw new ControlError(400, 'ROOM_ROUND', 'Only room posts have a round');
    }
    if (input.type === 'question' && this.askQuota(item, input.addressee!) >= 2) {
      throw new ControlError(409, 'BOARD_QUESTION_QUOTA', '本节点答疑次数已用完，请依据现有证据判断');
    }
    const result = this.insert({item: item.id, author, type: input.type, field: input.field, body: input.body,
      evidence: this.evidence(input.evidence ?? []), round,
      ...(input.target === undefined ? {} : {target: input.target}),
      ...(input.addressee === undefined ? {} : {addressee: input.addressee}),
      ...(input.room === undefined ? {} : {room: input.room})});
    if (input.type === 'answer' && target?.type === 'question') this.status(target, 'resolved');
    return result;
  }

  private insert(input: Omit<BoardPost, 'id' | 'seq' | 'at' | 'status'>): BoardPost {
    const latest = this.journal.database.prepare('SELECT MAX(seq) seq FROM board_posts WHERE item = ?').get(input.item) as {seq: number | null};
    const post: BoardPost = {...input, id: randomUUID(), seq: (latest.seq ?? 0) + 1, at: Date.now(), status: 'open'};
    this.journal.database.prepare(`INSERT INTO board_posts
      (id,item,seq,at,author,type,field,target,addressee,room,round,body,evidence,status) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
    ).run(post.id, post.item, post.seq, post.at, post.author, post.type, post.field, post.target ?? null,
      post.addressee ?? null, post.room ?? null, post.round, post.body, JSON.stringify(post.evidence), post.status);
    this.journal.append({kind: 'board.posted', post: structuredClone(post)});
    return post;
  }

  private status(post: BoardPost, status: BoardPostStatus): BoardPost {
    const updated = {...post, status};
    this.journal.database.prepare('UPDATE board_posts SET status = ? WHERE id = ?').run(status, post.id);
    this.journal.append({kind: 'board.posted', post: structuredClone(updated)});
    return updated;
  }

  private writeRoom(room: Room, kind: 'room.opened' | 'room.round' | 'room.closed'): void {
    this.journal.database.prepare(`INSERT INTO rooms
      (id,item,field,topic,participants,judge,max_rounds,round,status,opened_at,closed_at,outcome) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(id) DO UPDATE SET round = excluded.round, status = excluded.status,
        closed_at = excluded.closed_at, outcome = excluded.outcome`
    ).run(room.id, room.item, room.field, room.topic, JSON.stringify(room.participants), room.judge, room.maxRounds,
      room.round, room.status, room.openedAt, room.closedAt ?? null, room.outcome === undefined ? null : JSON.stringify(room.outcome));
    this.journal.append({kind, room: structuredClone(room)});
  }

  private decodePost(row: PostRow): BoardPost {
    const {target, addressee, room, evidence, ...post} = row;
    return {...post, ...(target === null ? {} : {target}), ...(addressee === null ? {} : {addressee}),
      ...(room === null ? {} : {room}), evidence: JSON.parse(evidence)};
  }

  private decodeRoom(row: RoomRow): Room {
    return {id: row.id, item: row.item, field: row.field, topic: row.topic, participants: JSON.parse(row.participants),
      judge: row.judge, maxRounds: row.max_rounds, round: row.round, status: row.status, openedAt: row.opened_at,
      ...(row.closed_at === null ? {} : {closedAt: row.closed_at}), ...(row.outcome === null ? {} : {outcome: JSON.parse(row.outcome)})};
  }

  private requireRoom(id: string): Room {
    const room = this.getRoom(id);
    if (!room) throw new ControlError(404, 'ROOM_NOT_FOUND', 'Unknown discussion room');
    return room;
  }

  private item(input: Item): ItemState {
    if (typeof input !== 'string') return validateItem(input);
    const exists = this.journal.database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'items'").get();
    const row = exists ? this.journal.database.prepare('SELECT body FROM items WHERE id = ?').get(input) as {body: string} | undefined : undefined;
    if (!row) throw new ControlError(404, 'BOARD_ITEM_NOT_FOUND', 'Unknown board item');
    return validateItem(deserializeSnapshot(row.body));
  }

  private node(item: ItemState, key: string): CompiledNode {
    const node = this.nodes.get(key);
    if (!node || !Object.hasOwn(item.nodes, key)) throw new ControlError(403, 'BOARD_AUTHOR', 'The node must belong to this item');
    return node;
  }

  private author(item: ItemState, author: string): string {
    text(author, 'author');
    if (author === 'supervisor' || author === 'user') return author;
    const key = author.replace(/^program:/, '');
    const node = this.node(item, key);
    if (author.startsWith('program:') && node.kind !== 'program') throw new ControlError(403, 'BOARD_AUTHOR', 'Invalid program author');
    return node.kind === 'program' ? `program:${key}` : key;
  }

  private resolveNode(item: ItemState, name: string, line?: string): string {
    if (this.nodes.has(name) && Object.hasOwn(item.nodes, name)) return name;
    if (line && this.nodes.has(`${line}/${name}`) && Object.hasOwn(item.nodes, `${line}/${name}`)) return `${line}/${name}`;
    const matches = this.order.filter(key => this.nodes.get(key)?.id === name && Object.hasOwn(item.nodes, key));
    if (matches.length !== 1) throw new ControlError(400, 'BOARD_OWNER', 'The fix must name one node in this item');
    return matches[0];
  }

  private outputKeys(values: unknown[]): string[] {
    const keys = values.filter((value): value is string => typeof value === 'string' && !hostKeys.has(value));
    for (const key of keys) fieldName(key);
    return [...new Set(keys.map(key => key.split('.')[0]))];
  }

  private evidence(value: unknown): string[] {
    if (!Array.isArray(value) || value.some(id => typeof id !== 'string' || !id.trim())) {
      throw new ControlError(400, 'BOARD_EVIDENCE', 'Evidence must contain evidence identifiers');
    }
    return [...value] as string[];
  }

  private writable(): void {
    if (this.journal.readOnly) throw new ControlError(403, 'BOARD_READ_ONLY', 'The board is read-only');
  }
}
