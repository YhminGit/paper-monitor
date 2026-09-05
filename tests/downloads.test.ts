import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, writeFile, stat, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { downloadPaper, extractPdf } from '../src/downloads.js';
import { paperId } from '../src/identity.js';
import type { fetchRemote } from '../src/http.js';
import type { Paper } from '../src/types.js';

const publisher = 'https://publisher.example/open.pdf';
const text = 'A verified learning analytics paper fixture with enough readable text to check extraction. This sentence tests complete PDF validation and downloadable archive publication.';

/** A real one-page PDF with correct object offsets and cross-reference table. */
function pdfFixture(): Buffer {
  const stream = `BT /F1 12 Tf 50 740 Td (${text}) Tj ET`;
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let content = '%PDF-1.4\n';
  const offsets = [0];
  objects.forEach((body, index) => { offsets.push(Buffer.byteLength(content)); content += `${index + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(content);
  content += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  content += offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  content += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(content);
}

function paper(id = 'paper'): Paper {
  return { id, aliases: [], journalId: 'jla', title: 'Learning analytics PDF test', authors: ['Test Author'], url: 'https://publisher.example/article', keywords: [], articleType: 'journal-article', firstSeenAt: '2025-01-01', updatedAt: '2026-01-01', publicationDate: { value: '2025-01-01', precision: 'day', source: 'publisher' }, relevance: { topic: 'learning-analytics', method: 'codex', confidence: 'high', reason: 'Fixture', evidence: [] }, oaLocations: [{ url: 'https://repository.example/article', pdfUrl: 'https://repository.example/accepted.pdf', hostType: 'repository', version: 'acceptedVersion', isOa: true, source: 'openalex' }, { url: 'https://publisher.example/article', pdfUrl: publisher, hostType: 'publisher', version: 'publishedVersion', license: 'CC-BY-4.0', isOa: true, source: 'publisher' }], pdf: { status: 'pending' }, milestones: [], provenance: [] };
}
async function fixture(p = paper()) {
  const output = await mkdtemp(path.join(os.tmpdir(), 'paper-download-test-'));
  const target = path.join(output, 'pdf', p.journalId, '2025', `${paperId(p.id)}.pdf`);
  await mkdir(path.dirname(target), { recursive: true });
  return { output, target, part: `${target}.part`, meta: `${target}.part.json`, cleanup: () => rm(output, { recursive: true, force: true }) };
}
function response(bytes: Buffer, status = 200, extra: Record<string, string> = {}) {
  return new Response(new Uint8Array(bytes), { status, headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(bytes.length), ETag: '"fixture-v1"', ...extra } });
}

test('extractPdf validates a genuine PDF and rejects HTML or a fake PDF signature', async () => {
  const f = await fixture();
  try {
    await writeFile(f.target, pdfFixture());
    const extracted = await extractPdf(f.target);
    assert.equal(extracted.pages, 1);
    assert.match(extracted.text, /verified learning analytics paper fixture/);
    await writeFile(f.target, '<html>A sign-in page</html>');
    await assert.rejects(extractPdf(f.target), /not a PDF/);
    await writeFile(f.target, '%PDF-1.7\n<html>Not a PDF document</html>\n%%EOF');
    await assert.rejects(extractPdf(f.target));
  } finally { await f.cleanup(); }
});

test('downloads publisher OA first, verifies checksum, extracts text and reuses a completed PDF', async () => {
  const p = paper(); const f = await fixture(p); const bytes = pdfFixture(); let requests = 0;
  try {
    const request: typeof fetchRemote = async url => { requests++; assert.equal(url, publisher); return response(bytes); };
    assert.equal(await downloadPaper(p, f.output, request), f.target);
    assert.equal(requests, 1);
    assert.equal(p.pdf.status, 'downloaded');
    assert.equal(p.pdf.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.equal(p.pdf.bytes, bytes.length);
    assert.equal(p.pdf.license, 'CC-BY-4.0');
    assert.equal(p.pdf.version, 'publishedVersion');
    assert.match(await readFile(`${f.target}.txt`, 'utf8'), /learning analytics paper fixture/);
    assert.equal(await downloadPaper(p, f.output, async () => { throw new Error('A completed file must not be requested again'); }), f.target);
    assert.equal(requests, 1);
  } finally { await f.cleanup(); }
});

test('closed locations are never requested', async () => {
  const p = paper(); p.oaLocations = p.oaLocations.map(location => ({ ...location, isOa: false })); const f = await fixture(p);
  try {
    assert.equal(await downloadPaper(p, f.output, async () => { throw new Error('Closed source was requested'); }), undefined);
    assert.equal(p.pdf.status, 'unavailable');
    await assert.rejects(stat(f.target), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('interrupted transfer persists bytes and resumes with Range and If-Range', async () => {
  const p = paper(); p.oaLocations = [p.oaLocations[1]]; const f = await fixture(p); const bytes = pdfFixture(); const split = Math.floor(bytes.length / 2);
  try {
    const interrupted: typeof fetchRemote = async () => {
      let pulls = 0;
      const body = new ReadableStream<Uint8Array>({ pull(controller) { if (pulls++ === 0) controller.enqueue(new Uint8Array(bytes.subarray(0, split))); else controller.error(new Error('Connection interrupted')); } });
      return new Response(body, { headers: { 'Content-Type': 'application/pdf', ETag: '"fixture-v1"', 'Content-Length': String(bytes.length) } });
    };
    assert.equal(await downloadPaper(p, f.output, interrupted), undefined);
    assert.equal(p.pdf.status, 'failed');
    assert.equal((await stat(f.part)).size, split);
    const resume: typeof fetchRemote = async (_url, init) => {
      const headers = new Headers(init?.headers);
      assert.equal(headers.get('range'), `bytes=${split}-`);
      assert.equal(headers.get('if-range'), '"fixture-v1"');
      return response(bytes.subarray(split), 206, { 'Content-Range': `bytes ${split}-${bytes.length - 1}/${bytes.length}` });
    };
    assert.equal(await downloadPaper(p, f.output, resume), f.target);
    assert.deepEqual(await readFile(f.target), bytes);
    await assert.rejects(stat(f.part), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('a fully transferred part recovers without another network request', async () => {
  const p = paper(); p.oaLocations = [p.oaLocations[1]]; const f = await fixture(p); const bytes = pdfFixture();
  try {
    await writeFile(f.part, bytes);
    await writeFile(f.meta, JSON.stringify({ url: publisher, etag: '"fixture-v1"', expectedTotal: bytes.length }));
    assert.equal(await downloadPaper(p, f.output, async () => { throw new Error('Completed parts must recover offline'); }), f.target);
    assert.equal(p.pdf.status, 'downloaded');
    assert.equal(p.pdf.sha256, createHash('sha256').update(bytes).digest('hex'));
    assert.deepEqual(await readFile(f.target), bytes);
    await assert.rejects(stat(f.meta), { code: 'ENOENT' });
  } finally { await f.cleanup(); }
});

test('server ignoring Range causes a clean replacement and HTTP 416 retries the full file', async () => {
  for (const rejectRange of [false, true]) {
    const p = paper(String(rejectRange)); p.oaLocations = [p.oaLocations[1]]; const f = await fixture(p); const bytes = pdfFixture(); let calls = 0;
    try {
      await writeFile(f.part, bytes.subarray(0, 30));
      await writeFile(f.meta, JSON.stringify({ url: publisher, etag: '"fixture-v1"' }));
      const request: typeof fetchRemote = async (_url, init) => {
        calls++; const headers = new Headers(init?.headers);
        assert.equal(headers.get('range'), calls === 1 ? 'bytes=30-' : null);
        return rejectRange && calls === 1 ? new Response(null, { status: 416 }) : response(bytes);
      };
      assert.equal(await downloadPaper(p, f.output, request), f.target);
      assert.equal(calls, rejectRange ? 2 : 1);
      assert.deepEqual(await readFile(f.target), bytes);
    } finally { await f.cleanup(); }
  }
});

test('HTML responses and partial ranges with the wrong offset are not published', async () => {
  for (const invalidRange of [false, true]) {
    const p = paper(String(invalidRange)); p.oaLocations = [p.oaLocations[1]]; const f = await fixture(p);
    try {
      if (invalidRange) { await writeFile(f.part, pdfFixture().subarray(0, 30)); await writeFile(f.meta, JSON.stringify({ url: publisher, etag: '"fixture-v1"' })); }
      const request: typeof fetchRemote = async () => invalidRange ? response(Buffer.from('broken'), 206, { 'Content-Range': 'bytes 20-25/100' }) : new Response('<html>Login required</html>', { headers: { 'Content-Type': 'text/html' } });
      assert.equal(await downloadPaper(p, f.output, request), undefined);
      assert.equal(p.pdf.status, 'failed');
      assert.match(p.pdf.error || '', invalidRange ? /partial-content/ : /instead of a PDF/);
      await assert.rejects(stat(f.target), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
});

test('a parser-recoverable truncated transfer remains unpublished', async () => {
  const p = paper(); p.oaLocations = [p.oaLocations[1]]; const f = await fixture(p); const complete = pdfFixture();
  const truncated = complete.subarray(0, complete.indexOf(Buffer.from('xref\n')));
  try {
    assert.equal(await downloadPaper(p, f.output, async () => response(truncated)), undefined);
    assert.equal(p.pdf.status, 'failed');
    await assert.rejects(stat(f.target), { code: 'ENOENT' });
    assert.equal((await stat(f.part)).size, truncated.length);
  } finally { await f.cleanup(); }
});

test('a complete-looking PDF is rejected when transfer lengths contradict its bytes', async () => {
  for (const ranged of [false, true]) {
    const p = paper(String(ranged)); p.oaLocations = [p.oaLocations[1]]; const f = await fixture(p); const bytes = pdfFixture();
    try {
      if (ranged) { await writeFile(f.part, bytes.subarray(0, 30)); await writeFile(f.meta, JSON.stringify({ url: publisher, etag: '"fixture-v1"' })); }
      const request: typeof fetchRemote = async () => ranged
        ? response(bytes.subarray(30), 206, { 'Content-Range': `bytes 30-${bytes.length + 4}/${bytes.length + 5}` })
        : response(bytes, 200, { 'Content-Length': String(bytes.length + 5) });
      assert.equal(await downloadPaper(p, f.output, request), undefined);
      assert.equal(p.pdf.status, 'failed');
      await assert.rejects(stat(f.target), { code: 'ENOENT' });
      let retryRequests = 0;
      assert.equal(await downloadPaper(p, f.output, async () => { retryRequests++; throw new Error('Offline retry fixture'); }), undefined);
      assert.equal(retryRequests, 1, 'A known-incomplete part must not bypass transfer validation through offline recovery.');
      assert.equal(p.pdf.status, 'failed');
      await assert.rejects(stat(f.target), { code: 'ENOENT' });
    } finally { await f.cleanup(); }
  }
});
