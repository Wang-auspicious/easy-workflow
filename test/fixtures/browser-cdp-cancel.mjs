import { openPage, closeBrowser } from '../../server/browser.ts';
const controller = new AbortController();
process.on('message', message => { if (message?.type === 'test:cancel') controller.abort(new Error('cancelled connecting to CDP')); });
try { await openPage(undefined, undefined, controller.signal); throw new Error('cancelled CDP lease was returned'); }
catch (error) { if (error.message !== 'cancelled connecting to CDP') throw error; process.send({ type: 'test:aborted' }); }
await closeBrowser();
process.exit(0);
