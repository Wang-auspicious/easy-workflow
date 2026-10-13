import type {DispatcherCheckpoint} from '../shared/conversation.ts';
import type {Failure} from '../shared/failures.ts';
import type {OperationReceipt} from '../shared/types.ts';
import {dispatcherOperationKey} from './dispatcher-recovery.ts';
import {ControlError} from './errors.ts';
import type {Journal} from './journal.ts';
import type {TokenRun} from './runtime.ts';

export interface OperationContext {
  journal: Journal;
  token: Pick<TokenRun, 'id' | 'data'>;
  node: string;
  revision: string;
}

type Phase = DispatcherCheckpoint['operations'][number]['phase'];
interface ReceiptIndex {
  seq: number;
  phase: Phase;
}

/** The project journal remains the only durable ledger. The index retains keys
 * and sequence numbers, not every external result body. */
class OperationLedger {
  readonly inflight = new Map<string, Promise<unknown>>();
  private readonly journal: Journal;
  private readonly receipts = new Map<string, ReceiptIndex>();
  private readonly parents = new Map<string, string>();
  private readonly scopes = new Map<string, string>();
  private seq = 0;

  constructor(journal: Journal) {
    this.journal = journal;
  }

  refresh() {
    for (const event of this.journal.read(this.seq)) {
      if (event.kind === 'operation.recorded') {
        this.receipts.set(event.operation.key, {
          seq: event.seq,
          phase: event.operation.phase,
        });
        this.scopes.set(event.operation.token, event.operation.scope);
      } else if (event.kind === 'token.data') {
        if (typeof event.patch.retryOf === 'string') {
          this.parents.set(event.token, event.patch.retryOf);
        }
        if (typeof event.patch.channelDelivery === 'string') {
          this.scopes.set(event.token, `channel:${event.patch.channelDelivery}`);
        }
      }
      this.seq = event.seq;
    }
  }

  scope(token: OperationContext['token']) {
    this.refresh();
    if (typeof token.data.channelDelivery === 'string') {
      return `channel:${token.data.channelDelivery}`;
    }
    if (typeof token.data.retryOf === 'string') {
      this.parents.set(token.id, token.data.retryOf);
    }
    let current = token.id;
    const visited = new Set<string>();
    while (current) {
      if (visited.has(current)) {
        throw new ControlError(409, 'operation_identity_invalid', '任务重试父链存在循环，不能执行外部写操作');
      }
      visited.add(current);
      const scope = this.scopes.get(current);
      if (scope) return scope;
      const parent = this.parents.get(current);
      if (!parent) return `token:${current}`;
      current = parent;
    }
    throw new ControlError(409, 'operation_identity_invalid', '缺少稳定任务身份，不能执行外部写操作');
  }

  read(key: string): OperationReceipt | undefined {
    this.refresh();
    const record = this.receipts.get(key);
    if (!record) return;
    for (const event of this.journal.read(record.seq - 1, undefined, record.seq)) {
      if (event.kind === 'operation.recorded' && event.operation.key === key) {
        return event.operation;
      }
    }
    throw new ControlError(503, 'operation_receipt_missing', '外部操作回执无法读取，不能重新执行');
  }

  append(operation: OperationReceipt) {
    this.journal.append({kind: 'operation.recorded', operation});
    this.refresh();
  }
}

const ledgers = new WeakMap<Journal, OperationLedger>();

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value).filter(([, entry]) => entry !== undefined);
    entries.sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function operationHash(name: string, value: unknown) {
  // Preserve the dispatcher's hashing primitive, while ensuring this new
  // receipt format is independent of the execution machine's locale.
  return dispatcherOperationKey(name, canonicalJson(value));
}

function jsonValue(value: unknown): unknown {
  const text = JSON.stringify(value);
  if (text === undefined || Buffer.byteLength(text) > 2 * 1024 * 1024) {
    throw new ControlError(422, 'operation_value_invalid', '外部操作的数据必须是 2MiB 内的 JSON 值');
  }
  return JSON.parse(text);
}

function waitForResult(promise: Promise<unknown>, signal?: AbortSignal) {
  signal?.throwIfAborted();
  if (!signal) return promise;
  return new Promise<unknown>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener('abort', abort);
      reject(signal.reason);
    };
    signal.addEventListener('abort', abort, {once: true});
    promise.then(result => {
      signal.removeEventListener('abort', abort);
      resolve(result);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}

function ledgerFor(journal: Journal) {
  let ledger = ledgers.get(journal);
  if (!ledger) {
    ledger = new OperationLedger(journal);
    ledgers.set(journal, ledger);
  }
  return ledger;
}

export class OperationUnknownError extends Error {
  readonly code = 'EXTERNAL_OPERATION_UNKNOWN';
  readonly operationKey: string;
  readonly failure: Failure;

  constructor(operationKey: string) {
    super(`外部操作 ${operationKey} 已开始但没有可确认的完整回执，结果未知；可能已经生效，系统不会自动重发。`);
    this.name = 'OperationUnknownError';
    this.operationKey = operationKey;
    this.failure = {
      tag: 'tool_error',
      category: 'system',
      code: this.code,
      message: this.message,
      retryable: false,
      owner: 'system',
      nextAction: '按 operation.recorded 回执核查远端操作结果；确认结果前保留此项，不能靠重新投料绕过未知状态。',
    };
  }
}

/** Uses the dispatcher's canonical hash and phase semantics for station effects.
 * Completed receipts can be replayed; started/uncertain effects cannot. */
export async function runDurableOperation(
  context: OperationContext | undefined,
  name: string,
  definition: unknown,
  input: unknown,
  invoke: () => Promise<unknown>,
  signal?: AbortSignal,
): Promise<unknown> {
  signal?.throwIfAborted();
  if (!context?.journal || !context.token.id || !context.node || !context.revision) {
    throw new ControlError(422, 'operation_context_required', '外部写操作必须绑定项目日志、任务、工位和版本；缺少持久回执上下文');
  }
  const ledger = ledgerFor(context.journal);
  const scope = ledger.scope(context.token);
  const inputHash = operationHash('workflow.input', jsonValue(input));
  const key = operationHash('workflow.effect', {
    scope,
    node: context.node,
    revision: context.revision,
    name,
    definition,
    inputHash,
  });
  const inflight = ledger.inflight.get(key);
  if (inflight) return structuredClone(await waitForResult(inflight, signal));

  const prior = ledger.read(key);
  if (prior?.phase === 'completed') return structuredClone(prior.result);
  if (prior) {
    if (prior.phase === 'started') {
      ledger.append({...prior, phase: 'uncertain', reason: 'interrupted'});
    }
    throw new OperationUnknownError(key);
  }

  const operation: OperationReceipt = {
    key,
    scope,
    token: context.token.id,
    node: context.node,
    revision: context.revision,
    name,
    inputHash,
    phase: 'started',
  };
  // This synchronous durable write must succeed before invoke can do any I/O.
  ledger.append(operation);
  const execute = async () => {
    let reason: OperationReceipt['reason'] = 'execution_failed';
    try {
      const result = jsonValue(await invoke());
      reason = 'receipt_failed';
      ledger.append({...operation, phase: 'completed', result});
      return result;
    } catch {
      // Error text can contain a URL credential or vendor output. The audit
      // records a reason code, never raw arguments, stderr or a provider error.
      try {
        ledger.append({...operation, phase: 'uncertain', reason});
      } catch {
        // A durable started intent alone still blocks replay after restart.
      }
      throw new OperationUnknownError(key);
    }
  };
  const pending = execute();
  ledger.inflight.set(key, pending);
  try {
    return structuredClone(await pending);
  } finally {
    ledger.inflight.delete(key);
  }
}
