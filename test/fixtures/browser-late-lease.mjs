import {openPage, closeBrowser} from '../../server/browser.ts';
const ctrl = new AbortController();
const start = Date.now();
const cleaned = new Promise(resolve => process.on('message', m => { if(m?.type==='test:cleaned')resolve(); }));
process.on('message', m=>{if(m?.type==='test:cancel')ctrl.abort(new Error('owner cancelled'));});
try { await openPage(undefined,undefined,ctrl.signal); throw new Error('cancelled lease was returned'); }
catch(error) { if(error.message!=='owner cancelled')throw error; process.send({type:'test:aborted',ms:Date.now()-start}); }
await cleaned;
await closeBrowser();
process.exit(0);
