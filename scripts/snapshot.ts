import fs from 'node:fs';
import path from 'node:path';
import {Factory} from '../server/factory.ts';

const args = process.argv.slice(2);
if (args.length !== 2 || args[0] !== '--project') {
  console.error('Usage: npm run snapshot -- --project <directory>');
  process.exitCode = 1;
} else {
  const directory = path.resolve(args[1]);
  if (!fs.existsSync(path.join(directory, 'journal.db'))) {
    console.error('Project must contain journal.db');
    process.exitCode = 1;
  } else {
    const started = performance.now();
    const factory = new Factory(directory, {projectionOnly: true});
    try {
      await factory.snapshot();
      console.log(`BOOT_STAGE snapshot-complete ${Math.round(performance.now() - started)}`);
    } catch {
      console.error('Snapshot failed; original events are unchanged');
      process.exitCode = 1;
    } finally {
      factory.journal.close();
    }
  }
}
