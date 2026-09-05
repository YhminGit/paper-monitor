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
