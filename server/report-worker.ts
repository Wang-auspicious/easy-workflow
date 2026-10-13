import fs from 'node:fs';
import path from 'node:path';
import {parentPort, workerData} from 'node:worker_threads';
import {Journal} from './journal.ts';
import {buildReport, type RunReport} from './report.ts';
import type {Factory} from './factory.ts';

interface ReportRequest {
  projectDir: string;
  compiled: Factory['compiled'];
  runId: string;
  through: number;
}

const {projectDir, compiled, runId, through} = workerData as ReportRequest;
if (!parentPort) throw new Error('Reports must be read inside a worker');
let journal: Journal | undefined;
try {
  let report: RunReport | undefined;
  const file = path.join(projectDir, 'runs', runId, 'report.json');
  if (fs.existsSync(file)) {
    const saved: RunReport = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (saved.version === 3 && saved.status === 'ended' && saved.metrics && saved.activity) {
      report = saved;
    }
  }
  if (!report) {
    journal = new Journal(path.join(projectDir, 'journal.db'), true);
    if (!journal.lastSequence(runId, through)) throw new Error('Run report not found');
    report = buildReport({compiled, journal} as Factory, runId, through);
  }
  // Transfer serialized bytes so neither JSON traversal nor copying blocks the server.
  const bytes = new TextEncoder().encode(JSON.stringify(report));
  parentPort.postMessage({body: bytes.buffer, seq: through, status: report.status}, [bytes.buffer]);
} catch (error) {
  parentPort.postMessage({error: error instanceof Error ? error.message : String(error)});
} finally {
  journal?.close();
}
