import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export interface SessionRef { file: string; signature: string }
export interface SavedStationSession {
  messages: unknown[]; evidence: {url:string;text:string}[]; calls: number;
  /** Only a bounded prior submit is carried into a session with a new role. */
  submitSummary?: string;
  /** Dialogue tools may change while the original station contract stays fixed. */
  roleRevision?: string;
  contractSignature?: string;
}
export const sessionSignature = (value: unknown) => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function loadStationSession(root: string, ref: SessionRef | undefined, signature: string): SavedStationSession | undefined {
  if (!ref || ref.signature !== signature) return;
  const file = path.resolve(root, ref.file), directory = path.resolve(root, 'work', 'agent-sessions');
  if (!file.startsWith(directory + path.sep)) return;
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.signature === signature && Array.isArray(saved.messages) && Array.isArray(saved.evidence) && Number.isSafeInteger(saved.calls)) return saved;
  } catch { /* Missing checkpoint: start this station from its durable input. */ }
}

export function saveStationSession(root: string, signature: string, session: SavedStationSession): SessionRef {
  const file = path.join('work', 'agent-sessions', `${crypto.randomUUID()}.json`);
  fs.mkdirSync(path.dirname(path.join(root,file)), {recursive:true});
  fs.writeFileSync(path.join(root,file), JSON.stringify({signature,...session}), {flag:'wx'});
  return {file,signature};
}
