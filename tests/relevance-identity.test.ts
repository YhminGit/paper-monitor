import assert from 'node:assert/strict';
import test from 'node:test';
import { mergePaper, mergePapers } from '../src/identity.js';
import { classify, isExcluded, relevant } from '../src/relevance.js';
import type { Paper } from '../src/types.js';

function paper(overrides: Partial<Paper> = {}): Paper {
  return {
    id: 'doi:10.1000/retention', doi: '10.1000/retention', aliases: ['doi:10.1000/retention'], journalId: 'bjet',
    title: 'AI feedback for learning analytics', authors: ['A. Author'], url: 'https://example.org/paper', keywords: ['AI'], articleType: 'journal-article',
    firstSeenAt: '2025-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    relevance: { topic: 'both', method: 'codex', confidence: 'high', reason: 'Historical semantic decision.', evidence: ['AI feedback'], reviewedAt: '2025-01-02T00:00:00Z' },
    oaLocations: [], pdf: { status: 'unavailable' }, milestones: [], provenance: [], ...overrides,
  };
}

test('explicit retracted, withdrawn and withdrawal publication labels override historical AI relevance', () => {
  for (const title of ['RETRACTED: AI feedback for learners', '  Retracted article: Learning analytics', '[RETRACTED] AI feedback', 'WITHDRAWN: An AI tutor', '[Withdrawn] Learning analytics', 'Withdrawal: An AI learning study', 'Withdrawal notice: AI feedback', 'Withdrawal of AI feedback research']) {
    const candidate = paper({ title });
    assert.equal(isExcluded(candidate), true, title);
    assert.equal(classify(candidate).topic, 'unrelated', title);
    assert.equal(relevant(candidate), false, title);
  }
  for (const articleType of ['retracted', 'withdrawn', 'withdrawal notice', 'article-withdrawn', 'info:eu-repo/semantics/retraction', 'book-review', 'editorial']) {
    const candidate = paper({ articleType });
    assert.equal(isExcluded(candidate), true, articleType);
    assert.equal(relevant(candidate), false, articleType);
  }
});

test('ordinary discussion of withdrawal, retracted research or editorial policy is not a publication exclusion', () => {
  for (const title of ['Withdrawal from online learning: Student accounts', 'Understanding student withdrawal using AI', 'Learning about retracted papers with AI', 'AI and editorial policy in education']) {
    const candidate = paper({ title });
    assert.equal(isExcluded(candidate), false, title);
    assert.equal(relevant(candidate), true, title);
  }
});

test('identity merge retains excluded article types against generic updates and accepts incoming exclusions', () => {
  for (const articleType of ['editorial', 'retraction', 'withdrawn', 'book-review']) {
    const merged = mergePaper(paper({ articleType }), paper({ articleType: 'journal-article' }));
    assert.equal(merged.articleType, articleType);
    assert.equal(relevant(merged), false);
  }
  const incomingExclusion = mergePaper(paper(), paper({ articleType: 'withdrawal' }));
  assert.equal(incomingExclusion.articleType, 'withdrawal');
  assert.equal(incomingExclusion.relevance.method, 'codex');
  assert.equal(relevant(incomingExclusion), false);
  assert.equal(mergePaper(paper({ articleType: 'editorial' }), paper({ articleType: 'retraction' })).articleType, 'retraction');
});

test('an explicit excluded title survives longer generic refreshes and shorter new status labels are accepted', () => {
  const old = paper({ title: 'RETRACTED: AI study' });
  const unmarked = paper({ title: 'An exceptionally detailed and much longer revised title of the AI study' });
  const merged = mergePaper(old, unmarked);
  assert.equal(merged.title, old.title);
  assert.equal(relevant(merged), false);
  const newlyWithdrawn = mergePaper(unmarked, paper({ title: 'WITHDRAWN: AI study' }));
  assert.equal(newlyWithdrawn.title, 'WITHDRAWN: AI study');
  assert.equal(relevant(newlyWithdrawn), false);
  const joined = mergePapers([old, unmarked, paper({ articleType: 'journal-article' })]);
  assert.equal(joined.length, 1);
  assert.equal(relevant(joined[0]), false);
});

test('equal-length incoming abstracts upgrade generic source labels to real provenance URLs', () => {
  const source = 'https://api.crossref.org/works/10.1000%2Fretention';
  const old = paper({ abstract: 'An earlier abstract.', abstractSource: 'Crossref author abstract' });
  const incoming = paper({ abstract: 'An updated abstract.', abstractSource: source });
  assert.equal(old.abstract!.length, incoming.abstract!.length);
  const merged = mergePaper(old, incoming);
  assert.equal(merged.abstract, incoming.abstract, 'Text and provenance must be updated together');
  assert.equal(merged.abstractSource, source);
  const sameText = mergePaper(paper({ abstract: 'Full abstract.', abstractSource: 'Publisher RSS' }), paper({ abstract: 'Full abstract.', abstractSource: 'https://publisher.example/feed' }));
  assert.equal(sameText.abstractSource, 'https://publisher.example/feed');
  const missingSource = mergePaper(paper({ abstract: 'Full abstract.' }), paper({ abstract: 'Full abstract.', abstractSource: source }));
  assert.equal(missingSource.abstractSource, source);
});

test('equal-length provenance upgrades do not replace established URLs or assign a different source to longer text', () => {
  const old = paper({ abstract: 'The original abstract has complete details.', abstractSource: 'https://publisher.example/original' });
  const established = mergePaper(old, paper({ abstract: old.abstract, abstractSource: 'https://other.example/abstract' }));
  assert.equal(established.abstractSource, old.abstractSource);
  const shorter = mergePaper({ ...old, abstractSource: 'Publisher RSS' }, paper({ abstract: 'Short.', abstractSource: 'https://api.crossref.org/works/10.1000%2Fretention' }));
  assert.equal(shorter.abstract, old.abstract);
  assert.equal(shorter.abstractSource, 'Publisher RSS');
  const invalidUrl = mergePaper({ ...old, abstractSource: 'Publisher RSS' }, paper({ abstract: old.abstract, abstractSource: 'javascript:alert(1)' }));
  assert.equal(invalidUrl.abstractSource, 'Publisher RSS');
});
