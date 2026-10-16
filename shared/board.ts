export type BoardPostType = 'claim' | 'challenge' | 'answer' | 'question' | 'evidence' | 'resolve' | 'note';
export type BoardPostStatus = 'open' | 'resolved' | 'rejected' | 'superseded';

/** A post's seq belongs to its item; journal events have their own global seq. */
export interface BoardPost {
  id: string;
  item: string;
  seq: number;
  at: number;
  author: string;
  type: BoardPostType;
  field: string;
  target?: string;
  addressee?: string;
  room?: string;
  round: number;
  body: string;
  evidence: string[];
  status: BoardPostStatus;
}

export interface BoardPostInput {
  type: BoardPostType;
  field: string;
  body: string;
  evidence?: string[];
  target?: string;
  addressee?: string;
  room?: string;
  round?: number;
}

/** Room claims encode this shape in body; ordinary automatic claims use summary. */
export interface RoomClaim {
  value: unknown;
  reason: string;
}

export interface RoomOutcome {
  value?: unknown;
  reason?: string;
}

export interface Room {
  id: string;
  item: string;
  field: string;
  topic: string;
  participants: string[];
  judge: string;
  maxRounds: number;
  round: number;
  status: 'open' | 'resolved' | 'judged' | 'parked';
  openedAt: number;
  closedAt?: number;
  outcome?: RoomOutcome;
}

export type BoardEvent =
  | {kind: 'board.posted'; post: BoardPost}
  | {kind: 'room.opened'; room: Room}
  | {kind: 'room.round'; room: Room}
  | {kind: 'room.closed'; room: Room};
