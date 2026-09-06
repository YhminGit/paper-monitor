import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rename, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createPaperServer } from '../src/server.js';
import type { Library, Paper } from '../src/types.js';

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, aliases: [], journalId: 'bjet', title: `Paper ${id}`, authors: ['Ada Lovelace'], url: 'https://example.org/paper', keywords: ['learning'], articleType: 'journal-article', abstract: 'Artificial intelligence for learning analytics.', abstractSource: 'publisher', firstSeenAt: '2026-01-01', updatedAt: '2026-01-01', relevance: { topic: 'both', method: 'rules', confidence: 'high', reason: 'Both topics', evidence: [] }, oaLocations: [], pdf: { status: 'unavailable' }, milestones: [], provenance: [], ...overrides };
}
function library(papers: Paper[]): Library {
  return { schemaVersion: 1, generatedAt: '2026-09-05T00:00:00Z', coverageStart: '2025-01-01', journals: [], sources: [], papers };
}
async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-server-test-'));
  const output = path.join(root, 'output');
  const dist = path.join(root, 'dist');
  await Promise.all([mkdir(path.join(output, 'pdf'), { recursive: true }), mkdir(path.join(output, 'reports'), { recursive: true }), mkdir(dist)]);
  await writeFile(path.join(dist, 'index.html'), '<!doctype html><main>Paper Monitor</main>');
  const server = createPaperServer({ outputDir: output, distDir: dist, journals: [] });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const snapshot = async (value: unknown) => { const temp = path.join(output, 'replacement.json'); await writeFile(temp, JSON.stringify(value)); await rename(temp, path.join(output, 'library.json')); };
  const cleanup = async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(root, { recursive: true, force: true }); };
  return { root, output, dist, base, snapshot, cleanup };
}

test('empty archive works and live atomic replacements keep the last good snapshot', async () => {
  const f = await fixture();
  try {
    let status = await (await fetch(`${f.base}/api/status`)).json();
    assert.equal(status.paperCount, 0);
    assert.equal(status.snapshotError, undefined);
    await f.snapshot(library([paper('a')]));
    assert.equal((await (await fetch(`${f.base}/api/papers`)).json()).total, 1);
    await f.snapshot({ schemaVersion: 1, papers: [{ id: 'broken' }] });
    assert.equal((await (await fetch(`${f.base}/api/papers`)).json()).total, 1);
    status = await (await fetch(`${f.base}/api/status`)).json();
    assert.match(status.snapshotError, /last valid snapshot/);
    await f.snapshot(library([paper('a'), paper('b')]));
    assert.equal((await (await fetch(`${f.base}/api/papers`)).json()).total, 2);
    status = await (await fetch(`${f.base}/api/status`)).json();
    assert.equal(status.snapshotError, undefined);
    assert.equal(typeof status.credentials.elsevier, 'boolean');
    assert.equal(status.papers, undefined);
  } finally { await f.cleanup(); }
});

test('serves search, details, SPA, reports and rejects invalid routes and origins', async () => {
  const f = await fixture();
  try {
    await f.snapshot(library([paper('doi/10.1.example', { title: 'A very long title '.repeat(50) }), paper('second', { journalId: 'jla' })]));
    const result = await (await fetch(`${f.base}/api/papers?name=ADA&journal=jla&keywords=learning+intelligence`)).json();
    assert.equal(result.total, 1);
    assert.equal(result.papers[0].id, 'second');
    assert.equal((await (await fetch(`${f.base}/api/papers/doi%2F10.1.example`)).json()).title.length, 900);
    assert.equal((await fetch(`${f.base}/api/papers?from=2025-02-29`)).status, 400);
    assert.equal((await fetch(`${f.base}/api/papers`, { headers: { Origin: 'https://attacker.example' } })).status, 403);
    const hostileHostStatus = await new Promise<number | undefined>((resolve, reject) => {
      const request = httpRequest(`${f.base}/api/papers`, { headers: { Host: 'attacker.example' } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode)); });
      request.on('error', reject); request.end();
    });
    assert.equal(hostileHostStatus, 403);
    assert.equal((await fetch(`${f.base}/api/papers`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${f.base}/api/papers/missing`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/reports/latest`)).status, 404);
    await writeFile(path.join(f.output, 'reports', 'latest.md'), '# Latest papers');
    assert.equal(await (await fetch(`${f.base}/api/reports/latest`)).text(), '# Latest papers');
    assert.match(await (await fetch(`${f.base}/papers/second`)).text(), /Paper Monitor/);
    assert.equal((await fetch(`${f.base}/.env`)).status, 404);
    assert.equal((await fetch(`${f.base}/api/missing`)).status, 404);
    const head = await fetch(`${f.base}/api/papers`, { method: 'HEAD' });
    assert.equal(head.status, 200);
    assert.equal(await head.text(), '');
  } finally { await f.cleanup(); }
});

test('abstract availability works through the API and rejects unknown values', async () => {
  const f = await fixture();
  try {
    await f.snapshot(library([paper('available'), paper('missing', { abstract: undefined }), paper('summary-only', { abstract: undefined, summary: 'Generated text.' })]));
    assert.equal((await (await fetch(`${f.base}/api/papers`)).json()).total, 3);
    const result = await (await fetch(`${f.base}/api/papers?abstract=available&name=ADA`)).json();
    assert.equal(result.total, 1);
    assert.equal(result.papers[0].id, 'available');
    assert.equal((await fetch(`${f.base}/api/papers?abstract=maybe`)).status, 400);
  } finally { await f.cleanup(); }
});

test('registered PDFs support ranges and attachment while paths remain private', async () => {
  const f = await fixture();
  try {
    const content = Buffer.from('%PDF-1.7\nthis is a test range fixture\n%%EOF');
    await writeFile(path.join(f.output, 'pdf', 'paper.pdf'), content);
    await f.snapshot(library([paper('a', { pdf: { status: 'downloaded', path: 'pdf/paper.pdf' } }), paper('escape', { pdf: { status: 'downloaded', path: '../dist/index.html' } })]));
    const details = await (await fetch(`${f.base}/api/papers/a`)).json();
    assert.equal(details.pdf.path, undefined);
    const range = await fetch(`${f.base}/api/papers/a/pdf`, { headers: { Range: 'bytes=0-7' } });
    assert.equal(range.status, 206);
    assert.equal(range.headers.get('content-range'), `bytes 0-7/${content.length}`);
    assert.equal(await range.text(), content.subarray(0, 8).toString());
    const suffix = await fetch(`${f.base}/api/papers/a/pdf`, { headers: { Range: 'bytes=-5' } });
    assert.equal(await suffix.text(), '%%EOF');
    const invalid = await fetch(`${f.base}/api/papers/a/pdf`, { headers: { Range: 'bytes=99999-' } });
    assert.equal(invalid.status, 416);
    const attachment = await fetch(`${f.base}/api/papers/a/pdf?download=1`);
    assert.match(attachment.headers.get('content-disposition')!, /^attachment;/);
    assert.equal(attachment.headers.get('content-type'), 'application/pdf');
    assert.deepEqual(Buffer.from(await attachment.arrayBuffer()), content);
    assert.equal((await fetch(`${f.base}/api/papers/escape/pdf`)).status, 404);
  } finally { await f.cleanup(); }
});

test('PDF symlinks cannot escape the registered directory', async t => {
  const f = await fixture();
  try {
    const target = path.join(f.root, 'private');
    await mkdir(target);
    await writeFile(path.join(target, 'secret.pdf'), '%PDF-1.7 secret');
    try { await symlink(target, path.join(f.output, 'pdf', 'escape'), 'junction'); }
    catch (error) { if (['EPERM', 'EACCES'].includes((error as NodeJS.ErrnoException).code || '')) { t.skip('This account cannot create directory symlinks.'); return; } throw error; }
    await f.snapshot(library([paper('escape', { pdf: { status: 'downloaded', path: 'pdf/escape/secret.pdf' } })]));
    assert.equal((await fetch(`${f.base}/api/papers/escape/pdf`)).status, 404);
  } finally { await f.cleanup(); }
});

test('abstract coverage is per journal and independent of successful article discovery', async () => {
  const f = await fixture();
  try {
    const value = library([
      paper('legacy-available'),
      paper('available', { abstractRetrieval: { checkedAt: '2026-09-06T00:00:00Z', status: 'available', errors: [] } }),
      paper('not-found', { abstract: undefined, abstractRetrieval: { checkedAt: '2026-09-07T00:00:00Z', status: 'not-found', errors: [] } }),
      paper('partial', { journalId: 'jla', abstract: undefined, abstractRetrieval: { checkedAt: '2026-09-08T00:00:00Z', status: 'partial', errors: ['Publisher: HTTP 429'] } }),
      paper('legacy-missing', { journalId: 'jla', abstract: undefined }),
      paper('summary-only', { journalId: 'jla', abstract: '  ', summary: 'A generated full-text summary.', abstractRetrieval: { checkedAt: '2026-09-09T00:00:00Z', status: 'not-found', errors: [] } }),
      paper('excluded', { relevance: { topic: 'unrelated', method: 'codex', confidence: 'high', reason: 'Unrelated', evidence: [] } }),
    ]);
    value.journals = [{ id: 'empty', name: 'Empty journal', shortName: 'Empty', issn: '1234-5678', publisher: 'wiley', url: 'https://example.org', feeds: [] }];
    value.sources = [{ journalId: 'bjet', status: 'ok', checkedAt: '2026-09-09T00:00:00Z', lastSuccessAt: '2026-09-09T00:00:00Z', discovered: 3, errors: [] }];
    await f.snapshot(value);
    const status = await (await fetch(`${f.base}/api/status`)).json();
    assert.equal(status.sources[0].status, 'ok');
    assert.equal(status.paperCount, 6);
    assert.deepEqual(status.abstractCoverage, { papers: 6, available: 2, missing: 4, summaries: 1, attempted: 4, partial: 1, notFound: 2, noRecordedCheck: 2, missingWithoutRecordedCheck: 1, lastCheckedAt: '2026-09-09T00:00:00Z' });
    assert.equal(status.contentCounts.abstracts, 2);
    assert.equal(status.contentCounts.missingAbstracts, 4);
    const bjet = status.abstractCoverageByJournal.find((row: { journalId: string }) => row.journalId === 'bjet');
    assert.deepEqual(bjet, { journalId: 'bjet', papers: 3, available: 2, missing: 1, summaries: 0, attempted: 2, partial: 0, notFound: 1, noRecordedCheck: 1, missingWithoutRecordedCheck: 0, lastCheckedAt: '2026-09-07T00:00:00Z' });
    const jla = status.abstractCoverageByJournal.find((row: { journalId: string }) => row.journalId === 'jla');
    assert.equal(jla.missing, 3);
    assert.equal(jla.partial, 1);
    assert.equal(jla.missingWithoutRecordedCheck, 1);
    const empty = status.abstractCoverageByJournal.find((row: { journalId: string }) => row.journalId === 'empty');
    assert.equal(empty.papers, 0);
    assert.equal(empty.lastCheckedAt, undefined);
  } finally { await f.cleanup(); }
});

test('local abstract retrieval details retain history but redact credentials, paths and bounded errors', async () => {
  const f = await fixture();
  try {
    const checkedAt = '2026-09-09T00:00:00Z';
    await f.snapshot(library([paper('partial', { abstract: undefined, abstractRetrieval: { checkedAt, status: 'partial', errors: [
      'Publisher HTTP 403 https://user:password@example.org/article?api_key=secret-key',
      'Repository failed at C:\\Users\\PrivatePerson\\archive\\record.json',
      'A'.repeat(1000),
      ...Array.from({ length: 15 }, () => 'Repeated unavailable source'),
    ] } }), paper('legacy', { abstract: undefined })]));
    const response = await fetch(`${f.base}/api/papers/partial`);
    const raw = await response.text();
    assert.equal(response.status, 200);
    assert.doesNotMatch(raw, /user:password|secret-key|PrivatePerson/);
    const details = JSON.parse(raw);
    assert.equal(details.abstractRetrieval.checkedAt, checkedAt);
    assert.equal(details.abstractRetrieval.status, 'partial');
    assert.equal(details.abstractRetrieval.errors.length, 12);
    assert.ok(details.abstractRetrieval.errors.every((error: string) => error.length <= 400));
    assert.match(details.abstractRetrieval.errors[0], /HTTP 403/);
    assert.match(details.abstractRetrieval.errors[1], /\[local path\]/);
    assert.equal((await (await fetch(`${f.base}/api/papers/legacy`)).json()).abstractRetrieval, undefined);
    await f.snapshot(library([paper('invalid', { abstractRetrieval: { checkedAt, status: 'partial', errors: [] } })]));
    assert.equal((await (await fetch(`${f.base}/api/papers/invalid`)).json()).abstractRetrieval.status, 'partial');
    const invalid = library([paper('broken')]) as any;
    invalid.papers[0].abstractRetrieval = { checkedAt, status: 'made-up', errors: [] };
    await f.snapshot(invalid);
    assert.equal((await (await fetch(`${f.base}/api/papers/invalid`)).json()).id, 'invalid');
    assert.match((await (await fetch(`${f.base}/api/status`)).json()).snapshotError, /last valid snapshot/);
  } finally { await f.cleanup(); }
});
