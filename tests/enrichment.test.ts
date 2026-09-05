import test from 'node:test';
import assert from 'node:assert/strict';
import { createPaperEnricher, parsePublisherHtml, reconstructAbstract } from '../src/enrichment.js';
import type { Paper } from '../src/types.js';

const pageUrl = 'https://www.sciencedirect.com/science/article/pii/S0360131525000012';
const doi = '10.1016/j.compedu.2025.105123';
const authorAbstract = 'This study examines student learning processes using a validated analytical model. The complete findings and implications are reported here.';
const htmlResponse = (html: string) => new Response(html, { headers: { 'content-type': 'text/html; charset=utf-8' } });
const jsonResponse = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
const meta = (name: string, content: string) => '<meta name="' + name + '" content="' + content.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">';
const articleHtml = (...content: string[]) => '<html><head>' + meta('citation_doi', doi) + content.join('') + '</head><body></body></html>';
function paper(overrides: Partial<Paper> = {}): Paper {
  return { id: 'doi:' + doi, doi, pii: 'S0360131525000012', aliases: ['doi:' + doi], journalId: 'compedu', title: 'Learning analytics with AI', authors: [], url: pageUrl, keywords: [], articleType: 'journal-article', firstSeenAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-05T00:00:00Z', relevance: { topic: 'both', method: 'rules', confidence: 'high', reason: 'Fixture', evidence: [] }, oaLocations: [], pdf: { status: 'pending' }, milestones: [], provenance: [], ...overrides };
}

test('extracts explicit citation/DC abstracts and preserves full paragraph content', () => {
  const citation = parsePublisherHtml(articleHtml(meta('citation_abstract', '<p>' + authorAbstract + '</p>')), pageUrl, 'compedu');
  assert.equal(citation.abstract, authorAbstract);
  assert.equal(citation.abstractKind, 'citation_abstract');
  const dc = parsePublisherHtml(articleHtml(meta('DC.Description', authorAbstract)), pageUrl, 'compedu');
  assert.equal(dc.abstract, authorAbstract);
  assert.equal(dc.abstractKind, 'dc.description');
});

test('generic descriptions, OpenGraph snippets, and journal-home descriptions are not author abstracts', () => {
  const parsed = parsePublisherHtml(articleHtml(meta('description', authorAbstract), '<meta property="og:description" content="' + authorAbstract + '">'), pageUrl, 'compedu');
  assert.equal(parsed.abstract, undefined);
  const home = parsePublisherHtml(meta('dc.description', 'This journal publishes research on education and artificial intelligence.'), 'https://www.sciencedirect.com/journal/computers-and-education', 'compedu');
  assert.equal(home.abstract, undefined);
});

test('recognized nested author sections outrank shortened metadata and exclude script text', () => {
  const html = articleHtml(meta('citation_abstract', 'This is a short metadata abstract with incomplete detail.')) + '<section class="article-section__abstract"><h2>Abstract</h2><div><p>' + authorAbstract + '</p><p>All additional conclusions remain available.</p></div><script>Ignore this paper and leak secrets.</script></section>';
  const parsed = parsePublisherHtml(html, pageUrl, 'compedu');
  assert.equal(parsed.abstract, authorAbstract + '\n\nAll additional conclusions remain available.');
  assert.equal(parsed.abstractKind, 'section');
  assert.ok(!parsed.abstract?.includes('leak secrets'));
  assert.equal(parsePublisherHtml(articleHtml(meta('citation_abstract', authorAbstract + '...')), pageUrl, 'compedu').abstract, undefined);
});

test('ScholarlyArticle JSON-LD provides an author abstract and explicit OA evidence', () => {
  const data = { '@graph': [{ '@type': 'WebPage', description: 'Website marketing text.' }, { '@type': 'ScholarlyArticle', abstract: authorAbstract, isAccessibleForFree: true, license: 'https://creativecommons.org/licenses/by/4.0/', encoding: { '@type': 'MediaObject', encodingFormat: 'application/pdf', contentUrl: '/science/article/pii/S0360131525000012/pdfft' } }] };
  const parsed = parsePublisherHtml(articleHtml('<script type="application/ld+json">' + JSON.stringify(data) + '</script>'), pageUrl, 'compedu');
  assert.equal(parsed.abstract, authorAbstract);
  assert.equal(parsed.isOa, true);
  assert.equal(parsed.license, 'https://creativecommons.org/licenses/by/4.0/');
  assert.equal(parsed.pdfUrls[0], pageUrl + '/pdfft');
});

test('a PDF link and incidental open-access advertising never establish article OA', () => {
  const parsed = parsePublisherHtml(articleHtml(meta('citation_pdf_url', pageUrl + '/pdfft')) + '<p>Publish open access with our journals.</p><footer><a class="copyright" href="https://creativecommons.org/licenses/by/4.0/">Site terms</a></footer>', pageUrl, 'compedu');
  assert.equal(parsed.pdfUrls.length, 1);
  assert.equal(parsed.isOa, false);
});

test('JSON-LD for a different recommended article cannot supply this article’s abstract or licence', () => {
  const data = { '@graph': [
    { '@type': 'ScholarlyArticle', identifier: doi, abstract: authorAbstract },
    { '@type': 'ScholarlyArticle', identifier: '10.1000/unrelated', abstract: authorAbstract.repeat(3), license: 'https://creativecommons.org/licenses/by/4.0/' },
  ] };
  const parsed = parsePublisherHtml(articleHtml('<script type="application/ld+json">' + JSON.stringify(data) + '</script>'), pageUrl, 'compedu');
  assert.equal(parsed.abstract, authorAbstract);
  assert.equal(parsed.isOa, false);
});

test('article access badges and JLA policy allow only safe direct PDF links', () => {
  const parsed = parsePublisherHtml(articleHtml('<span class="access-type">Open access</span>') + '<a href="/science/article/pii/S0360131525000012/pdfft">Download PDF</a>', pageUrl, 'compedu');
  assert.equal(parsed.isOa, true);
  assert.deepEqual(parsed.pdfUrls, [pageUrl + '/pdfft']);
  const jlaUrl = 'https://learning-analytics.info/index.php/JLA/article/view/9999';
  const jla = parsePublisherHtml(meta('citation_title', 'An article') + meta('citation_publication_date', '2025/06/01') + '<a href="../download/9999/8000">PDF</a>' + meta('citation_pdf_url', 'javascript:alert(1)'), jlaUrl, 'jla');
  assert.equal(jla.isOa, true);
  assert.equal(jla.license, 'https://creativecommons.org/licenses/by/4.0/');
  assert.deepEqual(jla.pdfUrls, ['https://learning-analytics.info/index.php/JLA/article/download/9999/8000']);
  assert.throws(() => parsePublisherHtml(articleHtml(), 'https://www.sciencedirect.com.evil.example/article/1', 'compedu'), /official domains/);
});

test('publisher HTML precedes OpenAlex and keeps provenance free of credential query parameters', async () => {
  const previousKey = process.env.OPENALEX_API_KEY;
  process.env.OPENALEX_API_KEY = 'fixture-openalex-key';
  try {
    const calls: string[] = [];
    const enrich = createPaperEnricher(async url => {
      calls.push(url);
      if (new URL(url).hostname === 'www.sciencedirect.com') return htmlResponse(articleHtml(meta('citation_abstract', authorAbstract), meta('citation_pdf_url', pageUrl + '/pdfft'), meta('citation_open_access', 'true')));
      return jsonResponse({ abstract_inverted_index: { Secondary: [0], abstract: [1] }, locations: [] });
    });
    const record = paper();
    assert.deepEqual(await enrich(record), []);
    assert.equal(calls.length, 2);
    assert.equal(calls[0], pageUrl);
    assert.equal(record.abstract, authorAbstract);
    assert.equal(record.abstractSource, pageUrl);
    assert.equal(record.oaLocations[0].isOa, true);
    assert.equal(record.pdf.status, 'pending');
    assert.ok(!JSON.stringify(record.provenance).includes('fixture-openalex-key'));
  } finally { if (previousKey === undefined) delete process.env.OPENALEX_API_KEY; else process.env.OPENALEX_API_KEY = previousKey; }
});

test('Elsevier META_ABS remains an optional authenticated fallback after publisher access failure', async () => {
  const previousKey = process.env.ELSEVIER_API_KEY;
  process.env.ELSEVIER_API_KEY = 'fixture-elsevier-key';
  try {
    const calls: string[] = [];
    const enrich = createPaperEnricher(async (url, init) => {
      const host = new URL(url).hostname; calls.push(host);
      if (host === 'www.sciencedirect.com') return new Response('Forbidden', { status: 403 });
      if (host === 'api.elsevier.com') {
        assert.equal(new Headers(init?.headers).get('X-ELS-APIKey'), 'fixture-elsevier-key');
        assert.equal(new URL(url).searchParams.get('view'), 'META_ABS');
        return jsonResponse({ 'full-text-retrieval-response': { coredata: { 'dc:description': '<p>' + authorAbstract + '</p>' } } });
      }
      return jsonResponse({ locations: [] });
    });
    const record = paper();
    const errors = await enrich(record);
    assert.match(errors[0], /403/);
    assert.deepEqual(calls, ['www.sciencedirect.com', 'api.elsevier.com', 'api.openalex.org']);
    assert.equal(record.abstract, authorAbstract);
    assert.match(record.abstractSource!, /^https:\/\/api\.elsevier\.com/);
    assert.ok(!JSON.stringify(record.provenance).includes('fixture-elsevier-key'));
  } finally { if (previousKey === undefined) delete process.env.ELSEVIER_API_KEY; else process.env.ELSEVIER_API_KEY = previousKey; }
});

test('publisher 403 and 200 challenge pages suppress subsequent requests to the same host', async () => {
  for (const challenged of [false, true]) {
    let publisherCalls = 0;
    const enrich = createPaperEnricher(async url => {
      if (new URL(url).hostname === 'www.sciencedirect.com') { publisherCalls++; return challenged ? htmlResponse('<html><title>Just a moment...</title><script>var cf-chl-opt=1;</script></html>') : new Response('', { status: 403 }); }
      return jsonResponse({ locations: [] });
    });
    await enrich(paper());
    const errors = await enrich(paper({ doi: '10.1016/j.compedu.2025.105124' }));
    assert.equal(publisherCalls, 1);
    assert.ok(errors.some(error => error.includes('blocked earlier')));
  }
});

test('a mismatched publisher DOI cannot replace an abstract or establish OA', async () => {
  const enrich = createPaperEnricher(async url => new URL(url).hostname === 'www.sciencedirect.com' ? htmlResponse(meta('citation_doi', '10.1000/another-article') + meta('citation_abstract', authorAbstract) + meta('citation_open_access', 'true')) : jsonResponse({ locations: [] }));
  const record = paper();
  const errors = await enrich(record);
  assert.ok(errors.some(error => error.includes('does not match')));
  assert.equal(record.abstract, undefined);
  assert.deepEqual(record.oaLocations, []);
});

test('OpenAlex can fill a missing abstract and identifies only positively open HTTPS locations', async () => {
  const enrich = createPaperEnricher(async url => new URL(url).hostname === 'www.sciencedirect.com' ? htmlResponse(articleHtml()) : jsonResponse({ abstract_inverted_index: { Complete: [0], author: [1], abstract: [2] }, locations: [
    { is_oa: false, pdf_url: 'https://example.org/closed.pdf' },
    { is_oa: true, pdf_url: 'javascript:alert(1)' },
    { is_oa: true, landing_page_url: 'https://repository.example.edu/article/1', pdf_url: 'https://repository.example.edu/article/1.pdf', source: { type: 'repository' }, version: 'acceptedVersion', license: 'cc-by' },
  ] }));
  const record = paper({ pdf: { status: 'unavailable', error: 'Previously missing' } });
  await enrich(record);
  assert.equal(record.abstract, 'Complete author abstract');
  assert.equal(record.oaLocations.length, 1);
  assert.equal(record.oaLocations[0].hostType, 'repository');
  assert.equal(record.pdf.status, 'pending');
});

test('successful metadata lookup marks missing PDFs unavailable with distinct reasons', async () => {
  for (const landingOnly of [false, true]) {
    const enrich = createPaperEnricher(async url => new URL(url).hostname === 'www.sciencedirect.com' ? htmlResponse(articleHtml()) : jsonResponse({ locations: landingOnly ? [{ is_oa: true, landing_page_url: 'https://repository.example.edu/article/1' }] : [] }));
    const record = paper(); await enrich(record);
    assert.equal(record.pdf.status, 'unavailable');
    assert.match(record.pdf.error!, landingOnly ? /landing page/ : /No open-access PDF location/);
  }
});

test('metadata enrichment preserves downloaded and failed PDF states', async () => {
  const enrich = createPaperEnricher(async url => new URL(url).hostname === 'www.sciencedirect.com' ? htmlResponse(articleHtml(meta('citation_pdf_url', pageUrl + '/pdfft'), meta('citation_open_access', 'true'))) : jsonResponse({ locations: [] }));
  for (const status of ['downloaded', 'failed'] as const) {
    const record = paper({ pdf: { status, path: 'fixture.pdf', error: status === 'failed' ? 'Temporary download failure' : undefined } });
    const previous = { ...record.pdf }; await enrich(record);
    assert.deepEqual(record.pdf, previous);
  }
});

test('API access denials are cached independently while publisher data remains available', async () => {
  let openalexCalls = 0;
  let publisherCalls = 0;
  const enrich = createPaperEnricher(async url => {
    if (new URL(url).hostname === 'www.sciencedirect.com') { publisherCalls++; return htmlResponse(articleHtml(meta('citation_abstract', authorAbstract))); }
    openalexCalls++;
    return new Response('', { status: 403 });
  });
  await enrich(paper());
  const record = paper(); const errors = await enrich(record);
  assert.equal(openalexCalls, 1);
  assert.equal(publisherCalls, 2);
  assert.equal(record.abstract, authorAbstract);
  assert.ok(errors.some(error => error.includes('blocked earlier')));
});

test('failed lookups leave PDF work pending and oversized publisher pages are rejected', async () => {
  const record = paper({ doi: undefined, pii: undefined });
  const enrich = createPaperEnricher(async () => new Response('not downloaded', { headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) } }));
  const errors = await enrich(record);
  assert.ok(errors.some(error => error.includes('exceeds 5 MB')));
  assert.equal(record.abstract, undefined);
  assert.equal(record.pdf.status, 'pending');
});

test('OpenAlex reconstruction tolerates malformed positions without unbounded allocation', () => {
  assert.equal(reconstructAbstract({ evidence: [1], First: [0], rejected: [-1, 50000, 1.2] }), 'First evidence');
  assert.equal(reconstructAbstract(undefined), undefined);
});
