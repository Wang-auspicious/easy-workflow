import { createRequire } from 'node:module';
const { copyProjectSnapshot } = createRequire(import.meta.url)('../app/project-data.cjs');
const [source, destination] = process.argv.slice(2);
if (!source || !destination) throw new Error('Usage: node scripts/migrate-project.mjs SOURCE_PROJECT NEW_PROJECT_FOLDER');
const receipt = await copyProjectSnapshot(source, destination, { withoutBrowserSession: process.argv.includes('--without-browser-session') });
console.log(JSON.stringify({ destination: receipt.destination, sourcePreserved: receipt.sourcePreserved, excluded: receipt.excluded, files: receipt.files.length, journal: receipt.journal }, null, 2));
