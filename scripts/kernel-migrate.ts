import fs from 'node:fs';
import path from 'node:path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const filtered = args.filter(argument => argument !== '--dry-run');
if (filtered.length !== 2 || filtered[0] !== '--project' || args.filter(argument => argument === '--dry-run').length > 1) {
  console.error('Usage: npm run kernel:migrate -- --project <directory> [--dry-run]');
  process.exitCode = 1;
} else {
  const directory = path.resolve(filtered[1]);
  const database = path.join(directory, 'journal.db');
  if (!fs.existsSync(database)) throw new Error('Project must contain journal.db');
  // Projection is always read-only. The write connection opens only after the
  // complete conversion succeeds, so --dry-run cannot create tables or caches.
  process.env.FACTORY_READONLY = '1';
  process.env.FACTORY_VAR = directory;
  process.env.FACTORY_DISCOVERY = '0';
  const [{Factory}, {Journal}, {KernelStore}, {migrateToken}] = await Promise.all([
    import('../server/factory.ts'), import('../server/journal.ts'),
    import('../server/kernel/store.ts'), import('../server/kernel/item.ts'),
  ]);
  const factory = new Factory(directory, {projectionOnly: true});
  let journal: InstanceType<typeof Journal> | undefined;
  try {
    const {compiled, state} = await factory.projectState();
    const existing = new KernelStore(factory.journal);
    const runs = new Map([...factory.journal.readKinds(['token.created'])]
      .flatMap(event => event.kind === 'token.created' ? [[event.token, event.run] as const] : []));
    const unfinished = Object.values(state.tokens).filter(token =>
      ['active', 'manual', 'parked', 'failed'].includes(token.status) && !token.data.retriedBy);
    const rows = unfinished.map(token => {
      const recoveryRoot = token.data.recoveryRoot ?? state.attempts[token.attempts[0]]?.node;
      const input = {...token, data: {...token.data, ...(recoveryRoot ? {recoveryRoot} : {})}};
      return {item: migrateToken(compiled, input, runs.get(token.id) ?? state.run.id, factory.workflowPacks!.conditions),
        existing: existing.get(token.id) !== undefined};
    });
    factory.journal.close();
    if (!dryRun) {
      journal = new Journal(database);
      const target = new KernelStore(journal);
      journal.atomic(() => {
        for (const row of rows) {
          if (target.get(row.item.id)) continue;
          target.save(row.item);
          for (const [node, value] of Object.entries(row.item.nodes)) {
            if (value.status === 'ready') journal!.append({kind: 'token.queued', token: row.item.id, node, from: 'kernel-migration'});
          }
        }
        journal!.append({kind: 'dispatch.note', tone: 'info',
          text: `v2 内核迁移：${rows.filter(row => !row.existing).length} 件货，既有记录保持不变`});
      });
    }
    for (const {item, existing: alreadyPresent} of rows) {
      const nodes: Record<string, number> = {};
      for (const node of Object.values(item.nodes)) nodes[node.status] = (nodes[node.status] ?? 0) + 1;
      console.log(JSON.stringify({id: item.id, status: item.status, nodes, alreadyPresent, dryRun}));
    }
    console.log(JSON.stringify({dryRun, total: rows.length,
      created: rows.filter(row => !row.existing).length, existing: rows.filter(row => row.existing).length}));
  } finally {
    journal?.close();
    // The read connection may have already been closed before migration writes.
    try { factory.journal.close(); } catch { /* Already closed. */ }
  }
}
