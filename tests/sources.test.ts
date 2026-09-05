import test from 'node:test';
import assert from 'node:assert/strict';
import { cleanText, createJournalDiscoverer, dateFromParts, normalizeDoi, parseCrossrefWork, parseOaiPage, parseRssFeed } from '../src/sources.js';
import type { Journal } from '../src/types.js';

const now = '2026-09-05T08:00:00.000Z';
const wiley: Journal = { id: 'bjet', name: 'British Journal of Educational Technology', shortName: 'BJET', issn: '1467-8535', publisher: 'wiley', url: 'https://bera-journals.onlinelibrary.wiley.com/journal/14678535', feeds: ['https://bera-journals.onlinelibrary.wiley.com/feed/14678535/most-recent'] };
const elsevier: Journal = { id: 'compedu', name: 'Computers & Education', shortName: 'C&E', issn: '0360-1315', publisher: 'elsevier', url: 'https://www.sciencedirect.com/journal/computers-and-education', feeds: ['https://rss.sciencedirect.com/publication/science/03601315'] };
const jla: Journal = { id: 'jla', name: 'Journal of Learning Analytics', shortName: 'JLA', issn: '1929-7750', publisher: 'jla', url: 'https://learning-analytics.info/index.php/JLA', feeds: ['https://learning-analytics.info/index.php/JLA/oai'] };

function crossrefWork(overrides: Record<string, unknown> = {}) {
  return { DOI: '10.1016/j.compedu.2025.105123', title: ['Learning <i>analytics</i> and AI'], author: [{ given: 'Jane', family: 'Doe' }, { name: 'Research Group' }], type: 'journal-article', 'published-online': { 'date-parts': [[2025, 1, 9]] }, resource: { primary: { URL: 'https://www.sciencedirect.com/science/article/pii/S0360131525000012' } }, ...overrides };
}

const rss = (items: string) => `<?xml version="1.0"?><rss version="2.0" xmlns:dc="http://purl.org/dc/elements/1.1/"><channel><title>Test feed</title>${items}</channel></rss>`;
const oai = (records: string, token = '') => `<?xml version="1.0"?><OAI-PMH xmlns="http://www.openarchives.org/OAI/2.0/" xmlns:oai_dc="http://www.openarchives.org/OAI/2.0/oai_dc/" xmlns:dc="http://purl.org/dc/elements/1.1/"><ListRecords>${records}${token ? `<resumptionToken completeListSize="2">${token}</resumptionToken>` : ''}</ListRecords></OAI-PMH>`;
const oaiRecord = (articleId = '9999', doi = '10.18608/jla.2025.9999') => `<record><header><identifier>oai:learning-analytics.info:article/${articleId}</identifier><datestamp>2026-09-01</datestamp></header><metadata><oai_dc:dc><dc:title>Learning analytics with AI</dc:title><dc:creator>Doe, Jane</dc:creator><dc:identifier>https://learning-analytics.info/index.php/JLA/article/view/${articleId}</dc:identifier><dc:identifier>${doi}</dc:identifier><dc:date>2025-06-01</dc:date><dc:description>&lt;p&gt;First abstract paragraph.&lt;/p&gt;&lt;p&gt;The complete second paragraph.&lt;/p&gt;</dc:description><dc:source>Journal of Learning Analytics; Vol. 12 No. 2 (2025)</dc:source><dc:subject>learning analytics</dc:subject><dc:relation>https://learning-analytics.info/index.php/JLA/article/download/${articleId}/8000</dc:relation><dc:rights>https://creativecommons.org/licenses/by/4.0/</dc:rights></oai_dc:dc></metadata></record>`;
const jsonResponse = (items: unknown[], cursor?: string) => new Response(JSON.stringify({ message: { items, 'next-cursor': cursor } }), { headers: { 'content-type': 'application/json' } });

test('preserves full JATS abstract text and cleans escaped HTML without script content', () => {
  assert.equal(cleanText('<jats:abstract><jats:p>First &amp; second.</jats:p><jats:p>All results &lt; 5.</jats:p></jats:abstract>'), 'First & second.\n\nAll results < 5.');
  assert.equal(cleanText('&lt;p&gt;A &amp;amp; B&lt;/p&gt;&lt;script&gt;ignore this&lt;/script&gt;'), 'A & B');
  assert.equal(cleanText('&#x1f4d6; &ndash; evidence'), '📖 – evidence');
});

test('cleaning author abstracts retains statistical comparison signs and adjacent findings', () => {
  assert.equal(cleanText('<jats:p>Effects were significant (p &lt; 0.05 and r &gt; 0.4). <jats:italic>Findings</jats:italic> were retained.</jats:p>'), 'Effects were significant (p < 0.05 and r > 0.4). Findings were retained.');
});

test('normalizes DOI variants and retains valid DOI suffix parentheses', () => {
  assert.equal(normalizeDoi('https://doi.org/10.1000%2FABC(2)'), '10.1000/abc(2)');
  assert.equal(normalizeDoi('doi: 10.1000/XYZ'), '10.1000/xyz');
  assert.equal(normalizeDoi('not an identifier'), undefined);
});

test('validates partial publication dates and leap days without inventing precision', () => {
  assert.deepEqual(dateFromParts({ 'date-parts': [[2025]] }, 'test'), { value: '2025', precision: 'year', source: 'test' });
  assert.deepEqual(dateFromParts([2025, 2], 'test'), { value: '2025-02', precision: 'month', source: 'test' });
  assert.equal(dateFromParts([2025, 2, 29], 'test'), undefined);
  assert.equal(dateFromParts([2024, 2, 29], 'test')?.value, '2024-02-29');
  assert.equal(dateFromParts([2025, 13], 'test'), undefined);
});

test('Crossref supplies full title, authors, DOI/PII aliases, and independent publication milestones', () => {
  const paper = parseCrossrefWork(crossrefWork({ subtitle: ['A longitudinal study'], abstract: '<jats:p>The full abstract.</jats:p>', 'published-print': { 'date-parts': [[2025, 6]] }, volume: '220', issue: '2', link: [{ URL: 'https://api.elsevier.com/content/article/pii/S0360131525000012?httpAccept=text/xml', 'content-type': 'text/xml', 'content-version': 'vor', 'intended-application': 'text-mining' }] }), elsevier, now)!;
  assert.equal(paper.title, 'Learning analytics and AI: A longitudinal study');
  assert.deepEqual(paper.authors, ['Jane Doe', 'Research Group']);
  assert.equal(paper.pii, 'S0360131525000012');
  assert.ok(paper.aliases.includes('pii:S0360131525000012'));
  assert.equal(paper.publicationDate?.value, '2025-01-09');
  assert.equal(paper.publishedIssue?.value, '2025-06');
  assert.equal(paper.publishedIssue?.precision, 'month');
  assert.deepEqual(paper.oaLocations, [], 'A TDM link does not establish open access');
  assert.equal(paper.abstract, 'The full abstract.');
  assert.equal(paper.abstractSource, 'https://api.crossref.org/works/10.1016%2Fj.compedu.2025.105123');
});

test('Wiley RDF dc:description retains the full author abstract', () => {
  const xml = `<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#" xmlns:dc="http://purl.org/dc/elements/1.1/"><item rdf:about="https://doi.org/10.1111/bjet.99999"><title>Full &amp; untruncated title</title><link>https://doi.org/10.1111/bjet.99999</link><dc:creator>Author One</dc:creator><dc:description><![CDATA[<p>Complete first paragraph.</p><p>Complete second paragraph.</p>]]></dc:description><dc:date>2025-04-02</dc:date></item></rdf:RDF>`;
  const paper = parseRssFeed(xml, wiley, wiley.feeds[0], now)[0];
  assert.equal(paper.title, 'Full & untruncated title');
  assert.equal(paper.abstract, 'Complete first paragraph.\n\nComplete second paragraph.');
  assert.equal(paper.doi, '10.1111/bjet.99999');
  assert.equal(paper.abstractSource, wiley.feeds[0]);
});

test('Elsevier feed timestamps and bibliography do not become first-online dates or abstracts', () => {
  const paper = parseRssFeed(rss('<item><title>Learning analytics and AI</title><link>https://www.sciencedirect.com/science/article/pii/S0360131525000012</link><pubDate>Sat, 5 Sep 2026 00:00:00 GMT</pubDate><description><![CDATA[Publication date: January 2025<br/>Source: Computers &amp; Education<br/>Author(s): Jane Doe]]></description></item>'), elsevier)[0];
  assert.equal(paper.pii, 'S0360131525000012');
  assert.equal(paper.publishedOnline, undefined);
  assert.equal(paper.publicationDate, undefined);
  assert.equal(paper.abstract, undefined);
  assert.equal(paper.abstractSource, undefined);
});

test('unlabeled and multiline ScienceDirect descriptions never become author abstracts', () => {
  const paper = parseRssFeed(rss('<item><title>AI feedback</title><link>https://www.sciencedirect.com/science/article/pii/S0360131525000012</link><description><![CDATA[Available online 1 September 2026<br/>Computers &amp; Education, Volume 240<br/>Jane Doe, John Roe<br/>Article 105000]]></description></item>'), elsevier)[0];
  assert.equal(paper.abstract, undefined);
  assert.equal(paper.abstractSource, undefined);
});

test('feed types and exact editorial categories survive generic metadata without matching research subjects', () => {
  const makeItem = (id: string, metadata: string) => `<item><title>AI and educational change</title><link>https://doi.org/10.1111/bjet.${id}</link>${metadata}</item>`;
  const papers = parseRssFeed(rss([
    makeItem('type', '<dc:type>Text</dc:type><dc:type>Editorial</dc:type>'),
    makeItem('prism', '<prism:aggregationType>editorial</prism:aggregationType>'),
    makeItem('category', '<category>Editorial</category>'),
    makeItem('methods', '<dc:type>Text</dc:type><dc:subject>Educational Methods</dc:subject><category>editorial policy</category>'),
    makeItem('uri', '<dc:type>info:eu-repo/semantics/editorial</dc:type>'),
  ].join('')), wiley);
  assert.deepEqual(papers.map(paper => paper.articleType), ['editorial', 'editorial', 'editorial', 'journal-article', 'editorial']);
});

test('OAI retains DOI/OAI aliases, publication date, full abstract, rights, and PDF relation', () => {
  const parsed = parseOaiPage(oai(oaiRecord(), 'resume&amp;next'), jla, jla.feeds[0], now);
  const paper = parsed.papers[0];
  assert.equal(parsed.resumptionToken, 'resume&next');
  assert.ok(paper.aliases.includes('oai:learning-analytics.info:article/9999'));
  assert.equal(paper.doi, '10.18608/jla.2025.9999');
  assert.equal(paper.publicationDate?.value, '2025-06-01', 'Header modification date is not publication date');
  assert.equal(paper.volume, '12');
  assert.equal(paper.issue, '2');
  assert.equal(paper.abstract, 'First abstract paragraph.\n\nThe complete second paragraph.');
  assert.equal(paper.abstractSource, jla.feeds[0]);
  assert.ok(paper.oaLocations.some(location => location.isOa && location.pdfUrl?.includes('/article/download/9999/') && location.license === 'https://creativecommons.org/licenses/by/4.0/'));
});

test('JLA honors explicit editorial subjects and retains the exact OAI provenance request URL', () => {
  const sourceUrl = `${jla.feeds[0]}?verb=ListRecords&resumptionToken=page-two`;
  const editorial = oaiRecord().replace('<dc:subject>learning analytics</dc:subject>', '<dc:type>Text</dc:type><dc:type>info:eu-repo/semantics/article</dc:type><dc:subject>Editorial</dc:subject>');
  const parsed = parseOaiPage(oai(editorial), jla, sourceUrl).papers[0];
  assert.equal(parsed.articleType, 'editorial');
  assert.equal(parsed.abstractSource, sourceUrl);
  const research = oaiRecord().replace('<dc:subject>learning analytics</dc:subject>', '<dc:type>Text</dc:type><dc:subject>Educational Methods</dc:subject><dc:subject>editorial policy</dc:subject>');
  assert.equal(parseOaiPage(oai(research), jla).papers[0].articleType, 'journal-article');
});

test('OAI skips deleted records and distinguishes empty responses from protocol errors', () => {
  const parsed = parseOaiPage(oai('<record><header status="deleted"><identifier>oai:deleted:1</identifier><datestamp>2026-01-01</datestamp></header></record>'), jla);
  assert.deepEqual(parsed.papers, []);
  assert.deepEqual(parsed.deletedIdentifiers, ['oai:deleted:1']);
  assert.deepEqual(parseOaiPage('<OAI-PMH><error code="noRecordsMatch">No records</error></OAI-PMH>', jla).papers, []);
  assert.throws(() => parseOaiPage('<OAI-PMH><error code="badResumptionToken">Expired</error></OAI-PMH>', jla), /badResumptionToken/);
});

test('malformed feed XML, HTML responses, and DTD/entity declarations are rejected', () => {
  assert.throws(() => parseRssFeed('<rss><channel></rss>', wiley), /Invalid feed XML/);
  assert.throws(() => parseRssFeed('<html><body>Challenge</body></html>', wiley), /not an RSS/);
  assert.throws(() => parseRssFeed('<!DOCTYPE rss [<!ENTITY attack SYSTEM "file:///secret">]><rss/>', wiley), /unsupported document type/);
});

test('Crossref DOI hydration merges a PII-only RSS paper without duplicate articles', async () => {
  const discover = createJournalDiscoverer(async input => {
    if (new URL(input).hostname === 'api.crossref.org') return jsonResponse([crossrefWork()]);
    return new Response(rss('<item><title>Learning analytics and AI</title><link>https://www.sciencedirect.com/science/article/pii/S0360131525000012</link></item>'));
  });
  const result = await discover(elsevier, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(result.complete, true);
  assert.equal(result.errors.length, 0);
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].doi, '10.1016/j.compedu.2025.105123');
  assert.equal(result.papers[0].provenance.length, 2);
  assert.equal(result.papers[0].publicationDate?.value, '2025-01-09');
});

test('publisher editorial classification is not overwritten by generic Crossref journal-article type', async () => {
  const discover = createJournalDiscoverer(async input => {
    if (new URL(input).hostname === 'api.crossref.org') return jsonResponse([crossrefWork({ DOI: '10.1111/bjet.editorial', resource: undefined })]);
    return new Response(rss('<item><title>Perspectives on AI</title><link>https://doi.org/10.1111/bjet.editorial</link><dc:type>Editorial</dc:type></item>'));
  });
  const result = await discover(wiley, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(result.papers.length, 1);
  assert.equal(result.papers[0].articleType, 'editorial');
});

test('OAI deleted identifiers produce a visible source warning while valid records continue', async () => {
  const deleted = '<record><header status="deleted"><identifier>oai:learning-analytics.info:article/retired</identifier></header></record>';
  const discover = createJournalDiscoverer(async input => new URL(input).hostname === 'api.crossref.org' ? jsonResponse([]) : new Response(oai(deleted + oaiRecord())));
  const result = await discover(jla, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(result.papers.length, 1);
  assert.equal(result.complete, true);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /1 deleted record.*oai:learning-analytics.info:article\/retired/);
  assert.match(result.errors[0], /retained pending verification/);
});

test('a failed publisher feed does not prevent successful Crossref discovery', async () => {
  const discover = createJournalDiscoverer(async input => {
    if (new URL(input).hostname === 'api.crossref.org') return jsonResponse([crossrefWork()]);
    throw new Error('HTTP 403');
  });
  const result = await discover(elsevier, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(result.papers.length, 1);
  assert.equal(result.complete, true);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /HTTP 403/);
});

test('a failed Crossref page preserves papers already discovered and does not mark coverage complete', async () => {
  const discover = createJournalDiscoverer(async input => {
    if (new URL(input).hostname === 'api.crossref.org') throw new Error('HTTP 503');
    return new Response(rss('<item><title>AI in education</title><link>https://doi.org/10.1111/bjet.12345</link></item>'));
  });
  const result = await discover(wiley, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(result.papers.length, 1);
  assert.equal(result.complete, false);
  assert.match(result.errors[0], /Crossref.*HTTP 503/);
});

test('Crossref pagination exhausts all pages and adds a seven-day incremental overlap', async () => {
  const crossrefUrls: URL[] = [];
  const discover = createJournalDiscoverer(async input => {
    const url = new URL(input);
    if (url.hostname !== 'api.crossref.org') return new Response(rss(''));
    crossrefUrls.push(url);
    return url.searchParams.get('cursor') === '*' ? jsonResponse(Array.from({ length: 1000 }, (_, index) => crossrefWork({ DOI: `10.1000/test${index}`, resource: undefined })), 'cursor-two') : jsonResponse([crossrefWork({ DOI: '10.1000/last', resource: undefined })]);
  });
  const result = await discover(wiley, { since: '2025-01-01', until: '2026-09-05', updateSince: '2026-09-04T09:00:00Z' });
  assert.equal(result.complete, true);
  assert.equal(result.papers.length, 1001);
  assert.equal(crossrefUrls.length, 2);
  assert.match(crossrefUrls[0].searchParams.get('filter')!, /from-index-date:2026-08-28/);
  assert.equal(crossrefUrls[1].searchParams.get('cursor'), 'cursor-two');
});

test('missing-title Crossref covers are skipped and aggregated across pages without aborting the import', async () => {
  assert.equal(parseCrossrefWork(crossrefWork({ title: [] }), wiley), undefined);
  let pages = 0;
  const discover = createJournalDiscoverer(async input => {
    const url = new URL(input);
    if (url.hostname !== 'api.crossref.org') return new Response(rss(''));
    pages++;
    if (url.searchParams.get('cursor') === '*') return jsonResponse(Array.from({ length: 1000 }, (_, index) => crossrefWork({ DOI: `10.1000/page${index}`, resource: undefined, ...(index < 2 ? { title: [] } : {}) })), 'second-page');
    return jsonResponse([crossrefWork({ title: [] }), crossrefWork({ DOI: '10.1000/final', resource: undefined })]);
  });
  const result = await discover(wiley, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(pages, 2);
  assert.equal(result.complete, true);
  assert.equal(result.papers.length, 999);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /Skipped 3 records/);
  assert.ok(result.papers.some(paper => paper.doi === '10.1000/final'));
});

test('diagnostic limit is always incomplete, including a fully fetched short page', async () => {
  const discover = createJournalDiscoverer(async input => new URL(input).hostname === 'api.crossref.org' ? jsonResponse([crossrefWork()]) : new Response(rss('')));
  const result = await discover(elsevier, { since: '2025-01-01', until: '2026-09-05', limit: 5 });
  assert.equal(result.complete, false);
  assert.equal(result.papers.length, 1);
});

test('OAI resumption requests omit the initial metadata/date arguments and merge Crossref records', async () => {
  const oaiUrls: URL[] = [];
  const discover = createJournalDiscoverer(async input => {
    const url = new URL(input);
    if (url.hostname === 'api.crossref.org') return jsonResponse([crossrefWork({ DOI: '10.18608/jla.2025.9999', resource: undefined })]);
    oaiUrls.push(url);
    return new Response(url.searchParams.has('resumptionToken') ? oai(oaiRecord('10000', '10.18608/jla.2025.10000')) : oai(oaiRecord(), 'next-page'));
  });
  const result = await discover(jla, { since: '2025-01-01', until: '2026-09-05' });
  assert.equal(result.complete, true);
  assert.equal(result.papers.length, 2);
  assert.equal(oaiUrls.length, 2);
  assert.equal(oaiUrls[0].searchParams.get('from'), '2025-01-01');
  assert.equal(oaiUrls[1].searchParams.get('resumptionToken'), 'next-page');
  assert.equal(oaiUrls[1].searchParams.has('metadataPrefix'), false);
  assert.equal(oaiUrls[1].searchParams.has('from'), false);
  assert.ok(result.papers.find(paper => paper.doi === '10.18608/jla.2025.9999')?.abstract);
});

test('coverage uses the canonical publication date and tolerates partial dates', async () => {
  const discover = createJournalDiscoverer(async input => new URL(input).hostname === 'api.crossref.org' ? jsonResponse([
    crossrefWork({ DOI: '10.1000/old', resource: undefined, 'published-online': { 'date-parts': [[2024, 12, 31]] }, 'published-print': { 'date-parts': [[2025, 3]] } }),
    crossrefWork({ DOI: '10.1000/month', resource: undefined, 'published-online': { 'date-parts': [[2025, 1]] } }),
    crossrefWork({ DOI: '10.1000/future', resource: undefined, 'published-online': { 'date-parts': [[2027]] } }),
  ]) : new Response(rss('')));
  const result = await discover(wiley, { since: '2025-01-15', until: '2026-09-05' });
  assert.deepEqual(result.papers.map(paper => paper.doi), ['10.1000/month']);
});
