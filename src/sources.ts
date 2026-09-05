import { createHash } from 'node:crypto';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { fetchRemote } from './http.js';
import type { Journal, OALocation, Paper, PaperDate } from './types.js';

type Data = Record<string, unknown>;
export interface DiscoveryOptions { since: string; until: string; updateSince?: string; limit?: number; }
export interface DiscoveryResult { papers: Paper[]; errors: string[]; complete: boolean; }
export interface OaiPage { papers: Paper[]; resumptionToken?: string; deletedIdentifiers: string[]; }

const xmlParser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@', textNodeName: '#text', parseTagValue: false, parseAttributeValue: false, trimValues: true });
const entities: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…', lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”', copy: '©', reg: '®' };
const asObject = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const asArray = <T>(value: T | T[] | undefined | null): T[] => value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];

function nodeText(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  if (Array.isArray(value)) return value.map(nodeText).filter(Boolean).join('\n');
  return Object.entries(asObject(value)).filter(([key]) => !key.startsWith('@')).map(([, child]) => nodeText(child)).filter(Boolean).join(' ');
}

function decodeEntities(value: string): string {
  return value.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const code = entity[1].toLowerCase() === 'x' ? Number.parseInt(entity.slice(2), 16) : Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '';
    }
    return entities[entity.toLowerCase()] ?? match;
  });
}

/** Remove display markup while retaining complete abstract paragraphs. Never render source HTML. */
export function cleanText(value: unknown): string {
  let text = nodeText(value);
  // Feeds commonly wrap escaped HTML in CDATA, so decode before stripping it.
  text = decodeEntities(decodeEntities(text));
  return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:[\w.-]+:)?(?:p|div|section|title|abstract|sec|h[1-6])\b[^>]*>/gi, '\n\n')
    .replace(/<(?:[\w.-]+:)?br\b[^>]*\/?\s*>/gi, '\n')
    .replace(/<\/?[a-z][\w:.-]*(?:\s[^<>]*?)?\s*\/?>/gi, '')
    .replace(/\r\n?/g, '\n').replace(/[\t\u00a0 ]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

const oneLine = (value: unknown): string => cleanText(value).replace(/\s+/g, ' ').trim();
const values = (value: unknown): string[] => asArray(value).map(item => oneLine(item)).filter(Boolean);
const unique = <T>(items: T[]): T[] => [...new Set(items)];

function explicitExcludedType(value: string): string | undefined {
  const type = value.toLowerCase().replace(/^.*\//, '').replace(/[-_]/g, ' ').trim();
  if (/^editorial(?: article| material)?$/.test(type)) return 'editorial';
  if (/^(correction|corrigendum|erratum|retraction|retracted|announcement|book review)$/.test(type)) return type;
  return undefined;
}

/** Type metadata is authoritative; only exact category labels can classify non-articles. */
function articleType(types: string[], categories: string[] = []): string {
  const excluded = [...types, ...categories].map(explicitExcludedType).find(Boolean);
  if (excluded) return excluded;
  return types.find(type => !/^(?:info:|text$|article$|journal$|journal[- ]article$|original article$|research article$)/i.test(type)) ?? 'journal-article';
}

export function normalizeDoi(value: unknown): string | undefined {
  let text = oneLine(value);
  try { text = decodeURIComponent(text); } catch { /* Keep the original identifier if its escaping is malformed. */ }
  text = text.replace(/^(?:doi\s*:\s*|https?:\/\/(?:dx\.)?doi\.org\/)/i, '').trim();
  const match = text.match(/10\.\d{4,9}\/[^\s<>"?#]+/i);
  return match?.[0].replace(/[.,;]+$/, '').toLowerCase();
}

function findPii(...candidates: unknown[]): string | undefined {
  for (const candidate of candidates) {
    const value = oneLine(candidate);
    const matched = value.match(/(?:\bpii[:/\s]*|\/pii\/)([A-Z0-9()\-]+)/i)?.[1] ?? value.match(/^S[0-9X()\-]{15,25}$/i)?.[0];
    if (matched) {
      const compact = matched.toUpperCase().replace(/[()\-]/g, '');
      if (/^S[0-9X]{16}$/.test(compact)) return compact;
    }
  }
  return undefined;
}

function safeUrl(value: unknown): string | undefined {
  const text = oneLine(value);
  try {
    const url = new URL(text);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return undefined;
    url.hash = '';
    if (url.hostname === 'dx.doi.org' || url.hostname === 'doi.org') url.protocol = 'https:';
    return url.href;
  } catch { return undefined; }
}

function xmlDocument(xml: string): Data {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Feed XML contains an unsupported document type or entity declaration');
  const validation = XMLValidator.validate(xml);
  if (validation !== true) throw new Error(`Invalid feed XML: ${validation.err.msg}`);
  return asObject(xmlParser.parse(xml));
}

export function dateFromParts(value: unknown, source: string): PaperDate | undefined {
  const object = asObject(value);
  const nestedParts = object['date-parts'];
  const raw = Array.isArray(nestedParts) ? nestedParts[0] : value;
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 3) return undefined;
  const parts = raw.map(Number);
  if (parts.some(part => !Number.isInteger(part))) return undefined;
  const [year, month, day] = parts;
  if (year < 1000 || year > 9999 || (month !== undefined && (month < 1 || month > 12))) return undefined;
  if (day !== undefined && (day < 1 || day > new Date(Date.UTC(year, month, 0)).getUTCDate())) return undefined;
  return { value: parts.map((part, index) => String(part).padStart(index === 0 ? 4 : 2, '0')).join('-'), precision: parts.length === 3 ? 'day' : parts.length === 2 ? 'month' : 'year', source };
}

function parseDate(value: unknown, source: string): PaperDate | undefined {
  const text = oneLine(value);
  const iso = text.match(/^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?(?:$|[T\s])/);
  if (iso) return dateFromParts(iso.slice(1).filter(part => part !== undefined).map(Number), source);
  // RSS pubDate is RFC 822; its calendar date is only a feed date, not an online milestone.
  if (!text || !/\d{4}/.test(text)) return undefined;
  const millis = Date.parse(text);
  return Number.isFinite(millis) ? dateFromParts(new Date(millis).toISOString().slice(0, 10).split('-').map(Number), source) : undefined;
}

function newPaper(journal: Journal, fields: Partial<Paper> & { title: string; url: string }, source: string, sourceUrl: string, now: string): Paper {
  const doi = fields.doi;
  const aliases = unique([...(fields.aliases ?? []), ...(doi ? [`doi:${doi}`] : []), ...(fields.pii ? [`pii:${fields.pii}`] : []), `url:${fields.url}`]);
  const id = doi ? `doi:${doi}` : fields.pii ? `pii:${fields.pii}` : aliases.find(alias => alias.startsWith('oai:')) ?? `url:${createHash('sha256').update(fields.url).digest('hex').slice(0, 24)}`;
  return {
    id, journalId: journal.id, authors: [], keywords: [], articleType: 'journal-article', firstSeenAt: now, updatedAt: now,
    relevance: { topic: 'pending', method: 'rules', confidence: 'low', reason: 'Awaiting relevance assessment.', evidence: [] },
    oaLocations: [], pdf: { status: 'pending' }, milestones: [], provenance: [{ source, url: sourceUrl, fetchedAt: now }],
    ...fields,
    aliases,
  };
}

/** Crossref links may be subscription/TDM URLs. OA enrichment happens separately. */
export function parseCrossrefWork(value: unknown, journal: Journal, now = new Date().toISOString()): Paper | undefined {
  const work = asObject(value);
  const doi = normalizeDoi(work.DOI);
  const titleParts = values(work.title);
  const title = [...titleParts, ...values(work.subtitle).filter(subtitle => !titleParts.some(part => part.includes(subtitle)))].join(': ');
  const resource = asObject(asObject(work.resource).primary);
  const links = asArray(work.link).map(link => asObject(link).URL);
  const identifiers = [...values(work['alternative-id']), ...links, resource.URL, work.URL];
  const pii = findPii(...identifiers);
  const url = safeUrl(resource.URL) ?? safeUrl(work.URL) ?? (doi ? `https://doi.org/${doi}` : undefined);
  if (!title || !url) return undefined;
  const online = dateFromParts(work['published-online'], 'crossref:published-online');
  const issueDate = dateFromParts(work['published-print'], 'crossref:published-print');
  const issued = dateFromParts(work.issued, 'crossref:issued');
  const volume = oneLine(work.volume) || undefined;
  const issue = oneLine(work.issue) || undefined;
  const abstract = cleanText(work.abstract) || undefined;
  const sourceUrl = doi ? `https://api.crossref.org/works/${encodeURIComponent(doi)}` : url;
  const publicationDate = online ?? issueDate ?? dateFromParts(work.published, 'crossref:published') ?? issued;
  return newPaper(journal, {
    title, doi, pii, url,
    aliases: identifiers.map(safeUrl).filter((item): item is string => Boolean(item)).map(link => `url:${link}`),
    authors: asArray(work.author).map(author => { const record = asObject(author); return oneLine(record.name) || [oneLine(record.given), oneLine(record.family)].filter(Boolean).join(' '); }).filter(Boolean),
    keywords: unique(values(work.subject)), articleType: oneLine(work.type) || 'journal-article',
    abstract, abstractSource: abstract ? sourceUrl : undefined,
    publishedOnline: online, publishedIssue: issueDate ?? (issue ? issued : undefined), publicationDate,
    volume, issue, pages: oneLine(work.page) || oneLine(work['article-number']) || undefined,
  }, 'crossref', sourceUrl, now);
}

function linkFromNode(value: unknown): string | undefined {
  for (const item of asArray(value)) {
    const record = asObject(item);
    if (record['@rel'] && record['@rel'] !== 'alternate') continue;
    const url = safeUrl(record['@href']) ?? safeUrl(nodeText(item));
    if (url) return url;
  }
  return undefined;
}

function jlaOaLocations(url: string, dates: PaperDate | undefined, relationUrls: string[], rights: string): OALocation[] {
  const suppliedLicense = rights.match(/https?:\/\/creativecommons\.org\/licenses\/[^\s<>]+/i)?.[0];
  // Journal policy: https://learning-analytics.info/index.php/JLA/policies (CC BY 4.0 from December 2024).
  const license = suppliedLicense ?? (dates && dates.value >= '2024-12' ? 'https://creativecommons.org/licenses/by/4.0/' : undefined);
  const locations = unique([url, ...relationUrls]).filter(candidate => {
    try { return ['learning-analytics.info', 'www.learning-analytics.info'].includes(new URL(candidate).hostname); } catch { return false; }
  });
  return locations.map(location => ({
    // OJS galley-view relation URLs identify the same file at the documented download route.
    url: location, pdfUrl: /\/article\/download\/|\.pdf(?:$|\?)/i.test(location) ? location : /\/article\/view\/\d+\/\d+(?:$|\?)/.test(location) ? location.replace('/article/view/','/article/download/') : undefined,
    hostType: 'publisher', version: 'publishedVersion', license, isOa: true, source: suppliedLicense ? 'JLA OAI rights' : 'JLA open-access policy',
  }));
}

export function parseRssFeed(xml: string, journal: Journal, feedUrl = journal.feeds[0], now = new Date().toISOString()): Paper[] {
  const document = xmlDocument(xml);
  const rss = asObject(document.rss);
  const rdf = asObject(document['rdf:RDF']);
  const atom = asObject(document.feed);
  if (!document.rss && !document['rdf:RDF'] && !document.feed) throw new Error('Response is not an RSS, RDF, or Atom feed');
  const items = asArray(asObject(rss.channel).item ?? rdf.item ?? atom.entry);
  return items.flatMap(item => {
    const entry = asObject(item);
    const title = oneLine(entry.title);
    const identifiers = [...values(entry['dc:identifier']), ...values(entry.identifier), oneLine(entry.guid), oneLine(entry.id)];
    const link = linkFromNode(entry.link) ?? safeUrl(entry['@rdf:about']) ?? identifiers.map(safeUrl).find(Boolean);
    const doi = identifiers.map(normalizeDoi).find(Boolean) ?? normalizeDoi(link) ?? normalizeDoi(entry['prism:doi']);
    const url = link ?? (doi ? `https://doi.org/${doi}` : undefined);
    if (!title || !url) return [];
    const pii = findPii(...identifiers, url);
    // ScienceDirect RSS descriptions are bibliographic blurbs, including unlabeled or multiline
    // content. Obtain author abstracts separately from Crossref or article metadata APIs.
    const abstract = journal.publisher === 'elsevier' ? undefined : cleanText(entry['dc:description'] ?? entry['content:encoded'] ?? entry.description ?? entry.summary ?? entry.content) || undefined;
    const rssDate = parseDate(entry['prism:coverDate'] ?? entry['dc:date'] ?? entry.published ?? entry.pubDate, 'publisher-rss');
    // Elsevier feed dates describe feed/issue updates and are not reliable first-online dates.
    const publicationDate = journal.publisher === 'elsevier' ? undefined : rssDate;
    const sourceIsAdvance = journal.publisher === 'sage' && new URL(feedUrl).searchParams.get('type') === 'axatoc';
    const sourceIsIssue = journal.publisher === 'sage' && new URL(feedUrl).searchParams.get('type') === 'etoc';
    const authors = values(entry['dc:creator']).concat(asArray(entry.author).map(author => oneLine(asObject(author).name ?? author)).filter(Boolean));
    const keywords = unique(values(entry['dc:subject']).concat(asArray(entry.category).map(category => oneLine(asObject(category)['@term'] ?? category)).filter(Boolean)));
    return [newPaper(journal, {
      title, doi, pii, url, aliases: identifiers.filter(identifier => identifier.startsWith('oai:')),
      authors: unique(authors), keywords,
      articleType: articleType([...values(entry['dc:type']), ...values(entry['prism:aggregationType'])], keywords),
      abstract, abstractSource: abstract ? feedUrl : undefined,
      publicationDate, publishedOnline: sourceIsAdvance ? rssDate : undefined, publishedIssue: sourceIsIssue ? rssDate : undefined,
      volume: oneLine(entry['prism:volume']) || undefined, issue: oneLine(entry['prism:number']) || undefined,
    }, 'publisher-rss', feedUrl, now)];
  });
}

export function parseOaiPage(xml: string, journal: Journal, sourceUrl = journal.feeds[0], now = new Date().toISOString()): OaiPage {
  const document = xmlDocument(xml);
  const root = asObject(document['OAI-PMH']);
  if (!document['OAI-PMH']) throw new Error('Response is not an OAI-PMH document');
  const errors = asArray(root.error).map(asObject);
  if (errors.some(error => error['@code'] !== 'noRecordsMatch')) throw new Error(`OAI-PMH error: ${errors.map(error => `${error['@code']}: ${nodeText(error)}`).join('; ')}`);
  if (errors.length) return { papers: [], deletedIdentifiers: [] };
  const list = asObject(root.ListRecords);
  if (!root.ListRecords) throw new Error('OAI-PMH response does not contain ListRecords');
  const deletedIdentifiers: string[] = [];
  const papers = asArray(list.record).flatMap(recordValue => {
    const record = asObject(recordValue);
    const header = asObject(record.header);
    const oaiId = oneLine(header.identifier);
    if (header['@status'] === 'deleted') { if (oaiId) deletedIdentifiers.push(oaiId); return []; }
    const dc = asObject(asObject(record.metadata)['oai_dc:dc']);
    const title = oneLine(asArray(dc['dc:title'])[0]);
    const identifiers = values(dc['dc:identifier']);
    const relations = values(dc['dc:relation']).map(safeUrl).filter((url): url is string => Boolean(url));
    const doi = identifiers.map(normalizeDoi).find(Boolean);
    const url = identifiers.map(safeUrl).find(candidate => candidate && !/(?:dx\.)?doi\.org\//i.test(candidate)) ?? (doi ? `https://doi.org/${doi}` : undefined);
    if (!title || !url) return [];
    const publicationDate = asArray(dc['dc:date']).map(date => parseDate(date, 'jla-oai:dc-date')).find(Boolean);
    const abstract = cleanText(dc['dc:description']) || undefined;
    const source = oneLine(dc['dc:source']);
    const volume = source.match(/\bVol(?:ume)?\.?\s*(\d+)/i)?.[1];
    const issue = source.match(/\bNo\.?\s*(\d+)/i)?.[1];
    const keywords = values(dc['dc:subject']);
    return [newPaper(journal, {
      title, doi, url, aliases: unique([...(oaiId ? [oaiId] : []), ...identifiers.map(safeUrl).filter((value): value is string => Boolean(value)).map(identifier => `url:${identifier}`)]),
      authors: values(dc['dc:creator']), keywords,
      abstract, abstractSource: abstract ? sourceUrl : undefined,
      publicationDate, volume, issue, publishedIssue: issue ? publicationDate : undefined,
      articleType: articleType(values(dc['dc:type']), journal.publisher === 'jla' ? keywords : []),
      oaLocations: journal.publisher === 'jla' ? jlaOaLocations(url, publicationDate, relations, nodeText(dc['dc:rights'])) : [],
    }, 'jla-oai', sourceUrl, now)];
  });
  return { papers, deletedIdentifiers, resumptionToken: oneLine(list.resumptionToken) || undefined };
}

function mergePapers(papers: Paper[]): Paper[] {
  const byId = new Map<string, Paper>();
  const aliasToId = new Map<string, string>();
  for (const incoming of papers) {
    const existingIds = unique(incoming.aliases.map(alias => aliasToId.get(alias)).filter((id): id is string => Boolean(id)));
    let merged = incoming;
    for (const existingId of existingIds) {
      const existing = byId.get(existingId);
      if (!existing) continue;
      // Discovery passes publisher metadata first and Crossref last. Preserve richer publisher abstracts.
      const defined = Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
      const abstractOwner = (existing.abstract?.length ?? 0) > (merged.abstract?.length ?? 0) ? existing : merged;
      merged = {
        ...existing, ...defined,
        aliases: unique([...existing.aliases, ...merged.aliases]),
        authors: merged.authors.length ? merged.authors : existing.authors,
        keywords: unique([...existing.keywords, ...merged.keywords]),
        articleType: articleType([existing.articleType, merged.articleType]),
        abstract: abstractOwner.abstract, abstractSource: abstractOwner.abstractSource,
        oaLocations: [...existing.oaLocations, ...merged.oaLocations].filter((location, index, all) => all.findIndex(candidate => candidate.url === location.url) === index),
        provenance: [...existing.provenance, ...merged.provenance],
      };
      merged.publicationDate = merged.publishedOnline ?? merged.publishedIssue ?? merged.publicationDate;
      byId.delete(existingId);
    }
    byId.set(merged.id, merged);
    for (const alias of merged.aliases) aliasToId.set(alias, merged.id);
  }
  return [...byId.values()];
}

function day(value: string): string {
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !parseDate(date, 'validation')) throw new Error(`Invalid discovery date: ${value}`);
  return date;
}

function overlapsCoverage(paper: Paper, since: string, until: string): boolean {
  const date = paper.publicationDate;
  if (!date) return true;
  const start = date.precision === 'year' ? `${date.value}-01-01` : date.precision === 'month' ? `${date.value}-01` : date.value;
  const end = date.precision === 'year' ? `${date.value}-12-31` : date.precision === 'month' ? `${date.value}-${new Date(Date.UTC(Number(date.value.slice(0, 4)), Number(date.value.slice(5, 7)), 0)).getUTCDate()}` : date.value;
  return start <= until && end >= since;
}

type RemoteFetcher = typeof fetchRemote;

async function readText(url: string, request: RemoteFetcher): Promise<string> {
  const response = await request(url, { headers: { Accept: 'application/xml,text/xml,application/rss+xml,application/atom+xml;q=0.9' } });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function discoverPublisher(journal: Journal, options: DiscoveryOptions, request: RemoteFetcher): Promise<{ papers: Paper[]; errors: string[] }> {
  const results = await Promise.all(journal.feeds.map(async feed => {
    const papers: Paper[] = [];
    const errors: string[] = [];
    const deletedIdentifiers = new Set<string>();
    try {
      if (journal.publisher !== 'jla') papers.push(...parseRssFeed(await readText(feed, request), journal, feed));
      else {
        let token: string | undefined;
        const usedTokens = new Set<string>();
        do {
          const url = new URL(feed);
          url.searchParams.set('verb', 'ListRecords');
          if (token) url.searchParams.set('resumptionToken', token);
          else {
            url.searchParams.set('metadataPrefix', 'oai_dc');
            // OAI from/until filter record modifications, not article publication dates.
            url.searchParams.set('from', options.updateSince ? overlapStart(options.updateSince) : options.since);
          }
          const page = parseOaiPage(await readText(url.href, request), journal, url.href);
          papers.push(...page.papers);
          page.deletedIdentifiers.forEach(identifier => deletedIdentifiers.add(identifier));
          token = page.resumptionToken;
          if (token && usedTokens.has(token)) throw new Error('OAI resumption token repeated before exhaustion');
          if (token) usedTokens.add(token);
          if (options.limit && papers.length >= options.limit) break;
        } while (token);
      }
    } catch (error) { errors.push(`${feed}: ${error instanceof Error ? error.message : String(error)}`); }
    if (deletedIdentifiers.size) errors.push(`${feed}: OAI reports ${deletedIdentifiers.size} deleted record${deletedIdentifiers.size === 1 ? '' : 's'} requiring review: ${[...deletedIdentifiers].join(', ')}. Existing archive entries are retained pending verification.`);
    return { papers, errors };
  }));
  return { papers: results.flatMap(result => result.papers), errors: results.flatMap(result => result.errors) };
}

function overlapStart(value: string): string {
  const timestamp = new Date(`${day(value)}T00:00:00Z`);
  timestamp.setUTCDate(timestamp.getUTCDate() - 7);
  return timestamp.toISOString().slice(0, 10);
}

async function discoverCrossref(journal: Journal, options: DiscoveryOptions, request: RemoteFetcher): Promise<DiscoveryResult> {
  const papers: Paper[] = [];
  const errors: string[] = [];
  let complete = false;
  let skippedRecords = 0;
  try {
    let cursor = '*';
    const usedCursors = new Set<string>();
    const rows = Math.min(options.limit ?? 1000, 1000);
    while (true) {
      const url = new URL(`https://api.crossref.org/journals/${encodeURIComponent(journal.issn)}/works`);
      const filters = [`from-pub-date:${options.since}`, `until-pub-date:${options.until}`];
      if (options.updateSince) filters.push(`from-index-date:${overlapStart(options.updateSince)}`);
      url.searchParams.set('filter', filters.join(','));
      url.searchParams.set('rows', String(rows));
      url.searchParams.set('cursor', cursor);
      if (process.env.CONTACT_EMAIL) url.searchParams.set('mailto', process.env.CONTACT_EMAIL);
      const response = await request(url.href, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const body = asObject(await response.json());
      const message = asObject(body.message);
      if (!Array.isArray(message.items)) throw new Error('Crossref response does not contain an items array');
      for (const item of message.items) {
        const paper = parseCrossrefWork(item, journal);
        if (!paper) { skippedRecords++; continue; }
        papers.push(paper);
      }
      if (options.limit && papers.length >= options.limit) break;
      if (message.items.length < rows) { complete = true; break; }
      const nextCursor = oneLine(message['next-cursor']);
      if (!nextCursor || usedCursors.has(nextCursor)) throw new Error('Crossref pagination stopped before exhaustion');
      usedCursors.add(nextCursor);
      cursor = nextCursor;
    }
  } catch (error) { errors.push(`Crossref ${journal.issn}: ${error instanceof Error ? error.message : String(error)}`); }
  if (skippedRecords) errors.push(`Crossref ${journal.issn}: Skipped ${skippedRecords} record${skippedRecords === 1 ? '' : 's'} without a usable article title or URL (for example issue covers); other records were processed normally.`);
  return { papers, errors, complete: complete && options.limit === undefined };
}

/** Inject a fetcher for deterministic offline adapter/pagination tests. */
export function createJournalDiscoverer(request: RemoteFetcher = fetchRemote) {
 return async function discover(journal: Journal, options: DiscoveryOptions): Promise<DiscoveryResult> {
  const since = day(options.since);
  const until = day(options.until);
  if (since > until) throw new Error('Discovery since must be on or before until');
  if (options.updateSince) day(options.updateSince);
  if (options.limit !== undefined && (!Number.isSafeInteger(options.limit) || options.limit < 1)) throw new Error('Discovery limit must be a positive integer');
  const normalizedOptions = { ...options, since, until };
  const [publisher, crossref] = await Promise.all([discoverPublisher(journal, normalizedOptions, request), discoverCrossref(journal, normalizedOptions, request)]);
  const papers = mergePapers([...publisher.papers, ...crossref.papers]).filter(paper => overlapsCoverage(paper, since, until));
  return { papers: options.limit ? papers.slice(0, options.limit) : papers, errors: [...publisher.errors, ...crossref.errors], complete: crossref.complete };
 };
}

/** Feeds are the fast path; Crossref exhaustion is required before advancing a journal cursor. */
export const discoverJournal = createJournalDiscoverer();
