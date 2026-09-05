import test from 'node:test';
import assert from 'node:assert/strict';
import { recoverIdentifiers } from '../src/identifier-recovery.js';
import type { Paper } from '../src/types.js';

const pii = 'S0360131526001879', doi = '10.1016/j.compedu.2026.105747';
const title = 'Trace-based measurement of self-regulated learning in primary mathematics: Implementation and validation within an adaptive learning platform';
const pageUrl = 'https://www.sciencedirect.com/science/article/pii/' + pii;
function paper(overrides: Partial<Paper> = {}): Paper {
  return { id: 'pii:' + pii, pii, aliases: ['pii:' + pii, 'url:' + pageUrl], journalId: 'compedu', title, authors: [], url: pageUrl, keywords: [], articleType: 'journal-article', firstSeenAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z', relevance: { topic: 'learning-analytics', method: 'codex', confidence: 'high', reason: 'Verified trace-based learning measurement', evidence: ['Learning traces'], reviewedAt: '2026-09-05T00:00:00Z', reviewedFingerprint: 'original-review' }, oaLocations: [], pdf: { status: 'pending' }, milestones: [{ kind: 'backfill', observedAt: '2026-09-05T00:00:00Z', runId: 'original-run' }], provenance: [{ source: 'rss', url: 'https://rss.sciencedirect.com/publication/science/03601315', fetchedAt: '2026-09-05T00:00:00Z' }], ...overrides };
}
function work(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { DOI: doi, title: [title], ISSN: ['0360-1315'], 'alternative-id': [pii], author: [{ given: 'Jane', family: 'Doe' }], type: 'journal-article', published: { 'date-parts': [[2027, 1]] }, URL: 'https://doi.org/' + doi, license: [{ URL: 'https://creativecommons.org/licenses/by/4.0/', 'content-version': 'vor', start: { 'date-parts': [[2026, 8, 28]] } }], ...overrides };
}
const response = (items: unknown[], total = items.length) => new Response(JSON.stringify({ message: { items, 'total-results': total } }), { headers: { 'content-type': 'application/json' } });

test('exact PII recovery preserves library identity/review and copies full Crossref metadata with licence provenance', async () => {
  const record = paper({ summary: 'Existing verified summary', summarySource: 'https://repository.example.edu/paper.pdf', summaryGeneratedAt: '2026-09-05T00:00:00Z', pdf: { status: 'downloaded', path: 'pdf/existing.pdf', sha256: 'existing-hash' }, abstractRetrieval: { checkedAt: '2026-09-05T00:00:00Z', status: 'not-found', errors: ['No DOI'] } });
  const before = JSON.stringify(record);
  let calls = 0;
  const result = await recoverIdentifiers([record], async (input, init) => {
    calls++; const url = new URL(input);
    assert.equal(url.origin + url.pathname, 'https://api.crossref.org/journals/0360-1315/works');
    assert.equal(url.searchParams.get('filter'), 'alternative-id:' + pii);
    assert.equal(url.searchParams.get('rows'), '5');
    assert.equal(url.searchParams.get('query.bibliographic'), null);
    assert.equal(new Headers(init?.headers).get('Accept'), 'application/json');
    return response([work({ abstract: '<jats:p>Complete author abstract.</jats:p>', subject: ['Learning analytics'], volume: '245', 'article-number': '105747' })]);
  });
  assert.equal(calls, 1); assert.deepEqual(result.errors, []);
  const actual = result.papers[0];
  assert.equal(JSON.stringify(record), before);
  assert.notEqual(actual, record);
  assert.equal(actual.id, record.id); assert.equal(actual.doi, doi); assert.equal(actual.pii, pii);
  assert.equal(actual.firstSeenAt, record.firstSeenAt);
  assert.deepEqual(actual.relevance, record.relevance); assert.deepEqual(actual.milestones, record.milestones);
  assert.deepEqual(actual.pdf, record.pdf); assert.equal(actual.summary, record.summary); assert.equal(actual.summarySource, record.summarySource);
  assert.deepEqual(actual.abstractRetrieval, record.abstractRetrieval);
  assert.deepEqual(actual.authors, ['Jane Doe']); assert.equal(actual.abstract, 'Complete author abstract.');
  assert.deepEqual(actual.keywords, ['Learning analytics']);
  assert.equal(actual.volume, '245'); assert.equal(actual.pages, '105747');
  assert.ok(actual.aliases.includes('doi:' + doi)); assert.ok(actual.aliases.includes('url:' + pageUrl));
  const sourceUrl = 'https://api.crossref.org/works/' + encodeURIComponent(doi);
  const provenance = actual.provenance.find(item => item.source === 'crossref')!;
  assert.equal(actual.abstractSource, sourceUrl); assert.equal(provenance.url, sourceUrl);
  assert.ok(Number.isFinite(Date.parse(provenance.fetchedAt)));
  assert.equal(actual.licenses![0].doi, doi); assert.equal(actual.licenses![0].appliesTo, 'vor');
  assert.equal(actual.licenses![0].fetchedAt, provenance.fetchedAt); assert.equal(actual.licenses![0].sourceUrl, sourceUrl);
  assert.equal(actual.licenses![0].start?.value, '2026-08-28');
});

test('future issue metadata preserves its real precision without inventing first-online publication', async () => {
  const result = await recoverIdentifiers([paper()], async () => response([work()]));
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.papers[0].publicationDate, { value: '2027-01', precision: 'month', source: 'crossref:published' });
  assert.equal(result.papers[0].publishedOnline, undefined);
  const dated = paper({ publishedOnline: { value: '2026-09-01', precision: 'day', source: 'publisher' } });
  const preserved = await recoverIdentifiers([dated], async () => response([work({ 'published-online': { 'date-parts': [[2026, 9]] } })]));
  assert.deepEqual(preserved.papers[0].publicationDate, dated.publishedOnline);
});

test('mismatched journal, exact PII, DOI and full title cannot hydrate a record', async () => {
  for (const override of [
    { ISSN: ['2666-920X'] }, { ISSN: undefined }, { 'alternative-id': ['S0360131526001887'] }, { 'alternative-id': undefined },
    { DOI: 'https://unrelated.example/' + doi }, { DOI: undefined }, { DOI: 'prefix ' + doi },
    { title: [title + ': unrelated extension'] }, { title: [title.slice(0, 40)] }, { title: ['Trace-based measurement of a different construct'] },
  ]) {
    const original = paper(), before = JSON.stringify(original);
    const result = await recoverIdentifiers([original], async () => response([work(override)]));
    assert.equal(result.errors.length, 1); assert.equal(result.papers[0], original);
    assert.equal(JSON.stringify(original), before); assert.equal(result.papers[0].doi, undefined);
  }
});

test('multiple DOIs are ambiguous even if only one title matches; truncated or malformed envelopes fail closed', async () => {
  const factories = [
    () => response([work(), work({ DOI: '10.1016/j.compedu.2026.999999', title: ['Different title'] })]),
    () => response([work()], 2), () => response([], 0),
    () => new Response(JSON.stringify({ message: { items: [work()] } })),
    () => new Response(JSON.stringify({ message: { items: {}, 'total-results': 0 } })),
    () => new Response('{invalid json'),
  ];
  for (const createResponse of factories) {
    const record = paper(); const result = await recoverIdentifiers([record], async () => createResponse());
    assert.equal(result.errors.length, 1); assert.equal(result.papers[0], record); assert.equal(record.doi, undefined);
  }
});

test('title normalization accepts HTML, Unicode typography, whitespace and case but no fuzzy text match', async () => {
  const record = paper({ title: 'Students’ trace–based learning: A “New” Study' });
  const result = await recoverIdentifiers([record], async () => response([work({ title: ['STUDENTS\' <i>trace-based</i> learning'], subtitle: ['A "New" Study'] })]));
  assert.deepEqual(result.errors, []); assert.equal(result.papers[0].doi, doi);
  const near = await recoverIdentifiers([record], async () => response([work({ title: ['Students\' trace-based learning: A "Newer" Study'] })]));
  assert.equal(near.errors.length, 1);
});

test('existing DOIs and other publishers are skipped, while invalid PII inputs remain visibly unresolved', async () => {
  let calls = 0;
  const records = [paper({ doi }), paper({ journalId: 'bjet' }), paper({ pii: undefined }), paper({ pii: 'S0360131526001879,alternative-id:other' }), paper({ pii: 'S2666920X26000123' })];
  const result = await recoverIdentifiers(records, async () => { calls++; return response([work()]); });
  assert.equal(calls, 0); assert.deepEqual(result.papers, records); assert.equal(result.errors.length, 3);
  assert.ok(result.errors.every(error => error.startsWith('Identifier recovery [')));
});

test('a repeated exact PII uses one lookup while preserving each original paper identity', async () => {
  let calls = 0;
  const records = [paper(), paper({ id: 'older-stable-id', pii: 's0360-1315(26)00187-9' })];
  const result = await recoverIdentifiers(records, async () => { calls++; return response([work(), work()]); });
  assert.equal(calls, 1); assert.deepEqual(result.errors, []);
  assert.deepEqual(result.papers.map(record => record.id), records.map(record => record.id));
  assert.ok(result.papers.every(record => record.doi === doi));
});

test('access denials and rate limits skip later requests without failing the run and are retryable next call', async () => {
  for (const status of [401, 403, 429]) {
    let calls = 0;
    const records = [paper(), paper({ id: 'next', pii: 'S0360131526001887' })];
    const result = await recoverIdentifiers(records, async () => { calls++; return new Response('', { status }); });
    assert.equal(calls, 1); assert.equal(result.errors.length, 2);
    assert.match(result.errors[0], new RegExp('HTTP ' + status)); assert.match(result.errors[1], /blocked earlier/);
    assert.deepEqual(result.papers, records);
    const retried = await recoverIdentifiers([records[0]], async () => response([work()]));
    assert.deepEqual(retried.errors, []); assert.equal(retried.papers[0].doi, doi);
  }
});

test('one transient failure does not prevent another PII recovery and errors redact credentials', async () => {
  const previousKey = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'identifier-fixture-key';
  try {
    let calls = 0;
    const secondPii = 'S0360131526001887';
    const result = await recoverIdentifiers([paper(), paper({ id: 'next', pii: secondPii })], async () => {
      calls++;
      if (calls === 1) throw new Error('Temporary failure api_key=identifier-fixture-key');
      return response([work({ 'alternative-id': [secondPii] })]);
    });
    assert.equal(calls, 2); assert.equal(result.errors.length, 1); assert.ok(!result.errors[0].includes('identifier-fixture-key'));
    assert.equal(result.papers[0].doi, undefined); assert.equal(result.papers[1].doi, doi);
  } finally { if (previousKey === undefined) delete process.env.OPENALEX_API_KEY; else process.env.OPENALEX_API_KEY = previousKey; }
});

test('all three Elsevier journals use their own ISSN endpoint and never request ScienceDirect', async () => {
  for (const [journalId, issn, pii] of [['compedu', '0360-1315', 'S0360131526001879'], ['caeai', '2666-920X', 'S2666920X26000123'], ['edurev', '1747-938X', 'S1747938X26000123']]) {
    const result = await recoverIdentifiers([paper({ journalId, pii })], async input => {
      const url = new URL(input); assert.equal(url.hostname, 'api.crossref.org');
      assert.equal(url.pathname, '/journals/' + issn + '/works');
      return response([work({ ISSN: [issn], 'alternative-id': [pii] })]);
    });
    assert.deepEqual(result.errors, []); assert.equal(result.papers[0].doi, doi);
  }
});
