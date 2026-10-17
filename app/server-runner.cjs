const path = require('node:path');
const fs = require('node:fs');
const { pathToFileURL } = require('node:url');
const root = process.env.FACTORY_ROOT || path.resolve(__dirname, '..');
const built = path.join(root, 'server', 'main.js');
console.log('BOOT_STAGE import 0');
import(pathToFileURL(fs.existsSync(built) ? built : path.join(root, 'server', 'main.ts')).href)
  .catch((error) => { console.error(error); process.exit(1); });
