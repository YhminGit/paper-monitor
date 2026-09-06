import assert from 'node:assert/strict';
import test from 'node:test';
import { dateInterval, parseSearch, searchPapers } from '../src/search.js';
import type { Paper } from '../src/types.js';

function paper(id: string, overrides: Partial<Paper> = {}): Paper {
  return { id, aliases: [], journalId: 'bjet', title: `Paper ${id}`, authors: ['Ada Lovelace'], url: 'https://example.org/paper', keywords: [], articleType: 'journal-article', firstSeenAt: '2026-01-01', updatedAt: '2026-01-01', relevance: { topic: 'ai', method: 'rules', confidence: 'high', reason: 'AI study', evidence: ['artificial intelligence'] }, oaLocations: [], pdf: { status: 'unavailable' }, milestones: [], provenance: [], ...overrides };
}
const filters = (query = '') => parseSearch(new URLSearchParams(query));

test('name matches title or author and keywords require every token across fields', () => {
  const papers = [paper('a', { title: 'Learning in schools', abstract: 'Neural models improve feedback', keywords: ['dashboard'] }), paper('b', { title: 'Learning in universities', summary: 'Neural feedback summary' })];
  assert.deepEqual(searchPapers(papers, filters('name=ADA&keywords=LEARNING+neural+dashboard')).papers.map(p => p.id), ['a']);
  assert.equal(searchPapers(papers, filters('name=SCHOOLS')).total, 1);
  assert.equal(searchPapers(papers, filters('name=unmatched')).total, 0);
  assert.equal(searchPapers(papers, filters('keywords=neural+summary')).papers[0].id, 'b');
});

test('journal and topic selections are OR within a filter and AND between filters', () => {
  const papers = [paper('a'), paper('b', { journalId: 'jla', relevance: { topic: 'both', method: 'rules', confidence: 'high', reason: '', evidence: [] }, pdf: { status: 'downloaded', path: 'pdf/b.pdf' } }), paper('c', { journalId: 'rer' }), paper('d', { relevance: { topic: 'pending', method: 'rules', confidence: 'low', reason: '', evidence: [] } })];
  assert.deepEqual(searchPapers(papers, filters('journal=bjet&journal=jla&topic=both&topic=ai')).papers.map(p => p.id), ['a', 'b']);
  assert.deepEqual(searchPapers(papers, filters('journal=bjet&journal=jla&pdf=downloaded')).papers.map(p => p.id), ['b']);
  assert.equal(searchPapers(papers, filters('pdf=unavailable')).total, 2);
  assert.equal(searchPapers(papers, filters()).total, 3);
});

test('inclusive dates use online date before issue date and partial dates overlap honestly', () => {
  const papers = [
    paper('day', { publishedOnline: { value: '2025-06-15', precision: 'day', source: 'publisher' }, publishedIssue: { value: '2026-01-01', precision: 'day', source: 'crossref' } }),
    paper('month', { publishedIssue: { value: '2025-06', precision: 'month', source: 'crossref' } }),
    paper('year', { publicationDate: { value: '2025', precision: 'year', source: 'crossref' } }),
    paper('unknown'),
    paper('outside', { publishedOnline: { value: '2025-06-16', precision: 'day', source: 'publisher' } }),
  ];
  assert.deepEqual(new Set(searchPapers(papers, filters('from=2025-06-15&to=2025-06-15')).papers.map(p => p.id)), new Set(['day', 'month', 'year']));
  assert.equal(searchPapers(papers, filters('from=2026&to=2026')).total, 0);
  assert.equal(searchPapers(papers, filters()).total, 5);
  assert.equal(searchPapers(papers, filters('from=2025-07')).total, 1);
});

test('abstract availability requires readable author text and excludes summaries and withheld content', () => {
  const papers = [
    paper('local', { abstract: 'An author abstract.' }),
    paper('licensed', { abstract: 'A licensed author abstract.', publicContent: { abstract: 'licensed' } }),
    paper('missing'),
    paper('whitespace', { abstract: ' \n\t ' }),
    paper('summary', { summary: 'A generated summary, not an author abstract.' }),
    paper('withheld', { abstract: 'Must not count even if retained accidentally.', publicContent: { abstract: 'withheld' } }),
    paper('unavailable', { abstract: 'Must not count.', publicContent: { abstract: 'unavailable' } }),
    paper('empty-licensed', { publicContent: { abstract: 'licensed' } }),
    paper('status-only', { abstractRetrieval: { status: 'available', checkedAt: '2026-09-06T00:00:00Z', errors: [] } }),
  ];
  assert.equal(filters().abstract, 'any');
  assert.equal(searchPapers(papers, filters()).total, papers.length);
  assert.equal(searchPapers(papers, filters('abstract=any')).total, papers.length);
  assert.deepEqual(searchPapers(papers, filters('abstract=available')).papers.map(p => p.id), ['licensed', 'local']);
});

test('abstract availability combines with other searches and filters using AND', () => {
  const matching = paper('match', { abstract: 'Neural feedback.', publishedOnline: { value: '2025-06-15', precision: 'day', source: 'publisher' }, pdf: { status: 'downloaded', path: 'pdf/match.pdf' } });
  const papers = [matching, { ...matching, id: 'no-abstract', abstract: undefined, summary: 'Neural feedback.' }, { ...matching, id: 'other-journal', journalId: 'jla' }];
  const query = 'abstract=available&name=ADA&keywords=neural+feedback&journal=bjet&topic=ai&from=2025-06-15&to=2025-06-15&pdf=downloaded';
  assert.deepEqual(searchPapers(papers, filters(query)).papers.map(p => p.id), ['match']);
  assert.equal(searchPapers(papers, filters(`${query}&journal=jla`)).total, 2);
  assert.equal(searchPapers(papers, filters(query.replace('ADA', 'unmatched'))).total, 0);
});

test('bookmarked abstract filters paginate matching records only and handle empty results', () => {
  const papers = Array.from({ length: 60 }, (_, index) => paper(String(index).padStart(2, '0'), { abstract: index % 2 ? 'Author abstract.' : undefined }));
  const bookmark = new URL('https://example.org/?abstract=available&page=2');
  const result = searchPapers(papers, parseSearch(bookmark.searchParams));
  assert.equal(result.total, 30);
  assert.equal(result.totalPages, 2);
  assert.equal(result.page, 2);
  assert.equal(result.papers.length, 5);
  assert.ok(result.papers.every(p => Boolean(p.abstract)));
  assert.deepEqual(searchPapers(papers, filters(bookmark.search)), result);
  assert.deepEqual(searchPapers([paper('missing')], filters('abstract=available&page=2')), { papers: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
});

test('validates calendar dates including leap years and filter bounds', () => {
  assert.deepEqual(dateInterval('2024-02'), { start: '2024-02-01', end: '2024-02-29' });
  assert.equal(dateInterval('2025-02-29'), undefined);
  assert.equal(dateInterval('2025-04-31'), undefined);
  for (const query of ['from=2025-13-01', 'from=2026&to=2025', 'page=-1', 'page=abc', 'pageSize=100', 'pdf=maybe', 'abstract=maybe', 'topic=unknown', 'sort=random']) assert.throws(() => filters(query));
});

test('pagination is fixed, deterministic, bounded and unknown dates sort last', () => {
  const papers = Array.from({ length: 27 }, (_, index) => paper(String(index).padStart(2, '0'), { publishedIssue: { value: `2025-01-${String(index + 1).padStart(2, '0')}`, precision: 'day', source: 'publisher' } }));
  papers.push(paper('unknown'));
  const first = searchPapers(papers, filters());
  assert.equal(first.papers[0].id, '26');
  assert.equal(first.papers.length, 25);
  assert.equal(first.totalPages, 2);
  const last = searchPapers(papers, filters('page=999'));
  assert.equal(last.page, 2);
  assert.equal(last.papers.at(-1)?.id, 'unknown');
  assert.equal(searchPapers(papers, filters('sort=oldest')).papers[0].id, '00');
  assert.deepEqual(searchPapers([], filters()), { papers: [], total: 0, page: 1, pageSize: 25, totalPages: 0 });
});
