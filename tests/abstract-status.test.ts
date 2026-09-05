import assert from 'node:assert/strict';
import test from 'node:test';
import type { Paper } from '../src/types.js';
import { abstractPresentation, publicAbstractCoverage } from '../web/abstract-status.js';

function paper(overrides: Partial<Paper> = {}): Paper {
  return { id: 'test', aliases: [], journalId: 'bjet', title: 'An AI study', authors: [], url: 'https://example.org/article', keywords: [], articleType: 'journal-article', firstSeenAt: '2026-09-06', updatedAt: '2026-09-06', relevance: { topic: 'ai', method: 'codex', confidence: 'high', reason: 'AI study', evidence: [] }, oaLocations: [], pdf: { status: 'unavailable' }, milestones: [], provenance: [], ...overrides };
}

test('missing local abstract with no recorded history does not claim it was never attempted', () => {
  const result = abstractPresentation(paper(), false);
  assert.equal(result.label, 'No recorded abstract check');
  assert.match(result.description, /Older retrieval attempts may predate/);
  assert.doesNotMatch(result.description, /never|not yet attempted/);
});

test('partial checks, not-found checks and available abstracts have distinct local labels', () => {
  const retrieval = { checkedAt: '2026-09-06T00:00:00Z', errors: [] };
  assert.equal(abstractPresentation(paper({ abstractRetrieval: { ...retrieval, status: 'partial' } }), false).label, 'Abstract retrieval incomplete');
  assert.equal(abstractPresentation(paper({ abstractRetrieval: { ...retrieval, status: 'not-found' } }), false).label, 'Author abstract not found');
  assert.equal(abstractPresentation(paper({ abstract: 'Author abstract.' }), false).kind, 'available');
  assert.equal(abstractPresentation(paper({ abstract: '   ', summary: 'A generated summary.' }), false).kind, 'unavailable');
});

test('public withheld status never implies failed retrieval or exposes private check history', () => {
  const result = abstractPresentation(paper({ abstract: 'Should not appear under a withheld flag', publicContent: { abstract: 'withheld' }, abstractRetrieval: { checkedAt: '2026-09-06', status: 'partial', errors: ['Private source notice'] } }), true);
  assert.equal(result.kind, 'withheld');
  assert.match(result.description, /redistribution permission/);
  assert.match(result.description, /does not mean/);
  assert.doesNotMatch(JSON.stringify(result), /Private source notice|2026-09-06/);
});

test('public availability requires both a licensed flag and actual author abstract text', () => {
  assert.equal(abstractPresentation(paper({ abstract: 'Licensed abstract.', publicContent: { abstract: 'licensed', license: 'cc-by' } }), true).kind, 'available');
  assert.equal(abstractPresentation(paper({ publicContent: { abstract: 'licensed', license: 'cc-by' } }), true).kind, 'unavailable');
  assert.equal(abstractPresentation(paper({ abstract: 'Without a recorded redistribution flag.' }), true).kind, 'unavailable');
  assert.equal(abstractPresentation(paper({ publicContent: { abstract: 'unavailable' }, summary: 'Generated summary.' }), true).kind, 'unavailable');
});

test('public abstract coverage separates licensed, withheld, missing and generated summaries', () => {
  const rows = [
    paper({ abstract: 'Licensed abstract.', publicContent: { abstract: 'licensed' } }),
    paper({ publicContent: { abstract: 'withheld' }, summary: 'Generated summary.' }),
    paper({ publicContent: { abstract: 'unavailable' } }),
    paper({ publicContent: { abstract: 'licensed' }, abstract: '  ' }),
  ];
  assert.deepEqual(publicAbstractCoverage(rows), { papers: 4, licensed: 1, withheld: 1, unavailable: 2, summaries: 1 });
  assert.deepEqual(publicAbstractCoverage([]), { papers: 0, licensed: 0, withheld: 0, unavailable: 0, summaries: 0 });
});
