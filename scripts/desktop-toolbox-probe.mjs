// Runs the real station toolbox over the Electron browser IPC bridge.
import { Toolbox } from '../server/toolbox.ts';
import { Broker } from '../server/broker.ts';
import { Journal } from '../server/journal.ts';
import { closeBrowser } from '../server/browser.ts';
import { closeNetwork } from '../server/network.ts';
const journal = new Journal(':memory:');
const broker = new Broker({ browser: 1, model: 1, cpu: 1, http: 1 }, 0);
const toolbox = new Toolbox({ journal, broker, docs: () => { throw new Error('This probe does not read documents'); } });
try {
  const context = { node: 'curation/reader', signal: AbortSignal.timeout(60000) };
  const text = await toolbox.call(['page_text'], 'page_text', { url: process.argv[2] }, context);
  const found = await toolbox.call(['page_find'], 'page_find', { url: process.argv[2], query: 'Rendered fixture content' }, context);
  process.send?.({ type: 'probe:result', result: { text, found, resources: broker.sample() } });
} catch (error) { process.send?.({ type: 'probe:error', error: error.message }); process.exitCode = 1; }
finally { await closeBrowser(); await closeNetwork(); journal.close(); process.disconnect?.(); }
