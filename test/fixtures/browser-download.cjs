const {app, BrowserWindow, session} = require('electron');
const http = require('node:http');
const path = require('node:path');
const {BrowserManager} = require(process.argv[3] || '../../app/browser-manager.cjs');

app.setPath('userData', process.argv[2]);
const fixture = http.createServer((_request, response) => {
  response.writeHead(200, {
    'content-type': 'font/ttf',
    'content-disposition': 'attachment; filename="specimen.ttf"',
  });
  response.end('isolated download regression fixture');
});

app.whenReady().then(async () => {
  await new Promise(resolve => fixture.listen(0, '127.0.0.1', resolve));
  const window = new BrowserWindow({show: false});
  const manager = new BrowserManager(path.join(app.getPath('userData'), 'browser'), () => {}, () => {});
  manager.attach(window);
  const observations = [];
  // Observe the real Electron decision, then suppress the test's own default
  // dialog regardless of verdict. A missing production guard must fail safely.
  session.fromPartition(manager.partition).on('will-download', (event, _item, contents) => {
    observations.push({id: contents.id, blocked: event.defaultPrevented});
    event.preventDefault();
  });
  try {
    for (const owner of ['agent', 'agent', 'agent', 'user']) {
      const tab = manager.create('about:blank', owner);
      await tab.ready;
      const before = observations.length;
      await tab.view.webContents.loadURL(`http://127.0.0.1:${fixture.address().port}/specimen.ttf`).catch(() => {});
      const deadline = Date.now() + 5000;
      while (observations.length === before && Date.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      if (observations.length !== before + 1) throw new Error(`No download event for ${owner}`);
      observations[before].owner = owner;
      tab.view.webContents.close();
    }
    console.log(`DOWNLOAD_RESULT ${JSON.stringify(observations)}`);
  } finally {
    await manager.close();
    window.destroy();
    fixture.closeAllConnections();
    await new Promise(resolve => fixture.close(resolve));
    app.quit();
  }
}).catch(error => {console.error(error); app.exit(1);});
