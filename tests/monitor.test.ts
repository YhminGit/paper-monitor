import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mergePapers, normalizeDoi } from '../src/identity.js';
import { eligibleDate, issueReady, notices, needsReview } from '../src/monitor.js';
import { classify, isExcluded } from '../src/relevance.js';
import { atomicWrite, readJson } from '../src/storage.js';
import type { Paper } from '../src/types.js';

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, aliases: [], journalId: 'bjet', title: `Learning analytics study ${id}`, authors: ['Ada Lovelace'], url: `https://example.org/${id}`, keywords: [], articleType: 'journal-article', firstSeenAt: '2025-01-01', updatedAt: '2026-01-01', relevance: { topic: 'learning-analytics', method: 'rules', confidence: 'low', reason: 'Topic phrase', evidence: ['learning analytics'] }, oaLocations: [], pdf: { status: 'unavailable' }, milestones: [], provenance: [], ...overrides };
}
const day = (value: string) => ({ value, precision: 'day' as const, source: 'publisher' });

test('normalizes DOI forms and merges an early-online DOI with a later DOI/PII issue record', () => {
  assert.equal(normalizeDoi(' HTTPS://DOI.ORG/10.1111/BJET.100 '), '10.1111/bjet.100');
  const online = paper('online', { doi: '10.1111/BJET.100', publishedOnline: day('2025-02-01'), milestones: [{ kind: 'online', observedAt: '2025-02-02T00:00:00Z' }] });
  const issue = paper('issue', { doi: 'https://doi.org/10.1111/bjet.100', pii: 'S12345', publishedIssue: day('2025-05-01'), volume: '55', issue: '3', abstract: 'Full publisher abstract', abstractSource: 'publisher' });
  const result = mergePapers([online, issue]);
  assert.equal(result.length, 1);
  assert.equal(result[0].id, 'online');
  assert.equal(result[0].pii, 'S12345');
  assert.equal(result[0].publicationDate?.value, '2025-02-01');
  assert.equal(result[0].abstractSource, 'publisher');
  assert.equal(result[0].milestones.length, 1);
  assert.equal(mergePapers([...result, issue]).length, 1);
});

test('records lacking URLs do not collapse unrelated journal papers', () => {
  const result = mergePapers([paper('a', { url: '' }), paper('b', { url: '', journalId: 'rer' })]);
  assert.equal(result.length, 2);
});

test('DOI–PII bridge preserves reviewed decisions, downloads, summaries and all delivered milestones', () => {
  const doiRecord = paper('doi-record', { doi: '10.1000/example', milestones: [{ kind: 'online', observedAt: '2025-02-02T00:00:00Z' }] });
  const piiRecord = paper('pii-record', { pii: 'S12345', title: 'A changed article title', summary: 'A verified full-text summary', summarySource: 'https://example.org/open.pdf', relevance: { topic: 'both', method: 'codex', confidence: 'high', reason: 'Verified semantic review', evidence: ['Detailed evidence'] }, pdf: { status: 'downloaded', path: 'pdf/test.pdf', sha256: 'abc' }, milestones: [{ kind: 'issue', observedAt: '2025-06-01T00:00:00Z' }] });
  const bridge = paper('bridge', { doi: '10.1000/example', pii: 'S12345', title: 'The final article title' });
  const result = mergePapers([doiRecord, piiRecord, bridge]);
  assert.equal(result.length, 1);
  assert.equal(result[0].pdf.status, 'downloaded');
  assert.equal(result[0].relevance.method, 'codex');
  assert.equal(result[0].summary, 'A verified full-text summary');
  assert.deepEqual(new Set(result[0].milestones.map(item => item.kind)), new Set(['online', 'issue']));
});

test('first backfill lists one current-state paper and unchanged reruns produce no notice', () => {
  const current = paper('a', { publishedOnline: day('2025-01-01'), publishedIssue: day('2025-05-01'), volume: '55' });
  assert.deepEqual(notices(current, undefined, true, '2026-01-01'), ['backfill']);
  const delivered = { ...current, milestones: [{ kind: 'backfill' as const, observedAt: '2026-01-01T00:00:00Z' }] };
  assert.deepEqual(notices(current, delivered, false, '2026-01-05'), []);
});

test('one later issue notification follows a previously delivered online/backfill milestone', () => {
  const online = paper('a', { publishedOnline: day('2025-01-01'), milestones: [{ kind: 'online', observedAt: '2025-01-02T00:00:00Z' }] });
  const issue = { ...online, publishedIssue: day('2025-05-01'), volume: '55' };
  assert.deepEqual(notices(issue, online, false, '2025-05-02'), ['issue']);
  const delivered = { ...issue, milestones: [...issue.milestones, { kind: 'issue' as const, observedAt: '2025-05-02T00:00:00Z' }] };
  assert.deepEqual(notices(issue, delivered, false, '2025-05-05'), []);
  const backfilledOnline = { ...online, milestones: [{ kind: 'backfill' as const, observedAt: '2025-01-02T00:00:00Z' }] };
  assert.deepEqual(notices(issue, backfilledOnline, false, '2025-05-02'), ['issue']);
  assert.equal(issueReady({ ...issue, volume: undefined }, '2025-05-02'), false);
});

test('a bridged paper already carrying an issue notice does not notify a second time', () => {
  const firstPrevious = paper('doi-record', { doi: '10.1000/example', publishedOnline: day('2025-01-01'), milestones: [{ kind: 'online', observedAt: '2025-01-02T00:00:00Z' }] });
  const combined = { ...firstPrevious, volume: '55', publishedIssue: day('2025-05-01'), milestones: [...firstPrevious.milestones, { kind: 'issue' as const, observedAt: '2025-05-02T00:00:00Z' }] };
  assert.deepEqual(notices(combined, firstPrevious, false, '2025-05-05'), []);
});

test('historical eligibility preserves partial dates and uses publication-date fallbacks', () => {
  assert.equal(eligibleDate(paper('old', { publicationDate: day('2024-12-31') }), '2026-09-05'), false);
  assert.equal(eligibleDate(paper('year', { publicationDate: { value: '2025', precision: 'year', source: 'crossref' } }), '2026-09-05'), true);
  assert.equal(eligibleDate(paper('month', { publicationDate: { value: '2026-09', precision: 'month', source: 'crossref' } }), '2026-09-05'), true);
  assert.equal(eligibleDate(paper('future', { publicationDate: day('2026-09-06') }), '2026-09-05'), false);
  assert.equal(eligibleDate(paper('unknown'), '2026-09-05'), true);
  assert.equal(eligibleDate(paper('online-only-old', { publishedOnline: day('2024-12-31') }), '2026-09-05'), false);
  assert.equal(eligibleDate(paper('issue-only-old', { publishedIssue: day('2024-12-31') }), '2026-09-05'), false);
});

test('publication exclusions take priority over AI phrases and learning analytics alone is not AI', () => {
  for (const title of ['Correction to: ChatGPT for learning analytics', 'Editorial: Artificial intelligence', 'Book review: Learning analytics', 'Retraction: An AI tutor', 'Call for papers: Generative AI']) {
    const candidate = paper(title, { title });
    assert.equal(isExcluded(candidate), true);
    assert.equal(classify(candidate).topic, 'unrelated');
  }
  assert.equal(classify(paper('la', { title: 'Learning analytics dashboards for feedback' })).topic, 'learning-analytics');
  assert.equal(classify(paper('ai', { title: 'ChatGPT supports teachers' })).topic, 'ai');
  assert.equal(classify(paper('both', { title: 'Learning analytics with large language models' })).topic, 'both');
  assert.equal(classify(paper('none', { title: 'A trial of collaborative learning', journalId: 'rer' })).topic, 'pending');
  assert.equal(classify(paper('mention', { title: 'Classroom motivation', abstract: 'Artificial intelligence is mentioned as background only.' })).confidence, 'low');
});

test('Codex pending papers remain reviewable after later metadata enrichment', () => {
 const candidate=paper('pending',{relevance:{topic:'pending',method:'codex',confidence:'low',reason:'Insufficient evidence',evidence:[]}});
 assert.equal(needsReview(candidate),true);
 assert.equal(needsReview({...candidate,abstract:'New evidence of AI-supported learning.'}),true);
 assert.equal(needsReview({...candidate,relevance:{...candidate.relevance,topic:'ai'}}),false);
 assert.equal(needsReview({...candidate,title:'Editorial: Artificial intelligence'}),false);
});

test('atomic writes replace complete files and malformed state is never silently reset', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-storage-test-'));
  const file = path.join(root, 'state.json');
  try {
    assert.deepEqual(await readJson(file, { empty: true }), { empty: true });
    await atomicWrite(file, '{"generation":1}');
    await atomicWrite(file, '{"generation":2}');
    assert.deepEqual(await readJson(file), { generation: 2 });
    assert.equal(await readFile(file, 'utf8'), '{"generation":2}');
    await writeFile(file, '{broken');
    await assert.rejects(readJson(file, { empty: true }), SyntaxError);
  } finally { await rm(root, { recursive: true, force: true }); }
});
