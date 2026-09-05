import type { OALocation, Paper } from './types.js';
import { fetchRemote, safeError } from './http.js';
import { cleanText, normalizeDoi } from './sources.js';

type Data = Record<string, unknown>;
type Requester = typeof fetchRemote;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const text = (value: unknown): string | undefined => typeof value === 'string' ? cleanText(value) || undefined : undefined;
const officialHosts: Record<string, string[]> = {
  bjet: ['bera-journals.onlinelibrary.wiley.com', 'onlinelibrary.wiley.com'],
  berj: ['bera-journals.onlinelibrary.wiley.com', 'onlinelibrary.wiley.com'],
  compedu: ['www.sciencedirect.com', 'sciencedirect.com'],
  edurev: ['www.sciencedirect.com', 'sciencedirect.com'],
  caeai: ['www.sciencedirect.com', 'sciencedirect.com'],
  rer: ['journals.sagepub.com'], jla: ['learning-analytics.info', 'www.learning-analytics.info'],
};

function httpsUrl(value: unknown, base?: string): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  try {
    const url = new URL(cleanText(value), base);
    if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) return undefined;
    url.hash = '';
    return url.href;
  } catch { return undefined; }
}
function isOfficial(url: string, journalId: string): boolean {
  return (officialHosts[journalId] ?? []).includes(new URL(url).hostname);
}
function attributes(value: string): Record<string, string> {
  const found: Record<string, string> = {};
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>\x60]+)))?/g;
  for (const match of value.matchAll(pattern)) found[match[1].toLowerCase()] = cleanText(match[2] ?? match[3] ?? match[4] ?? '');
  return found;
}
function tags(html: string, tag: string): Array<{ attrs: Record<string, string>; end: number }> {
  const found: Array<{ attrs: Record<string, string>; end: number }> = [];
  const pattern = new RegExp('<' + tag + '\\b((?:"[^"]*"|\'[^\']*\'|[^\'">])*)>', 'gi');
  for (const match of html.matchAll(pattern)) found.push({ attrs: attributes(match[1]), end: match.index! + match[0].length });
  return found;
}
function sectionBody(html: string, tag: string, start: number): string | undefined {
  const pattern = new RegExp('<(/?)' + tag + '\\b((?:"[^"]*"|\'[^\']*\'|[^\'">])*)>', 'gi');
  pattern.lastIndex = start;
  let depth = 1;
  for (let match = pattern.exec(html); match; match = pattern.exec(html)) {
    if (match[1]) depth--;
    else if (!match[0].endsWith('/>')) depth++;
    if (!depth) return html.slice(start, match.index);
  }
  return undefined;
}
function abstractText(value: unknown): string | undefined {
  const candidate = text(typeof value === 'string' ? value : object(value)['@value']);
  if (!candidate) return undefined;
  const cleaned = candidate.replace(/^(?:Abstract|Summary)\s*(?::|\n)\s*/i, '').trim();
  if (cleaned.length < 40 || /(?:\.\.\.|…)\s*$/.test(cleaned)) return undefined;
  if (/^(?:please (?:enable|sign in|log in)|access denied|verify you are human|this journal (?:publishes|aims)|subscribe to|purchase this article)/i.test(cleaned)) return undefined;
  return cleaned;
}
function ccLicense(value: unknown): string | undefined {
  const raw = typeof value === 'string' ? value : object(value).url ?? object(value)['@id'];
  if (typeof raw !== 'string') return undefined;
  const match = raw.match(/https?:\/\/creativecommons\.org\/(?:licenses\/(?:by(?:-nc)?(?:-nd|-sa)?|by-nd|by-sa)\/\d(?:\.\d)?|publicdomain\/zero\/1\.0)\/?/i);
  return match?.[0].replace(/^http:/i, 'https:');
}
function scholarlyNodes(html: string): Data[] {
  const found: Data[] = [];
  const visit = (value: unknown, depth = 0): void => {
    if (depth > 12) return;
    if (Array.isArray(value)) { for (const child of value) visit(child, depth + 1); return; }
    const node = object(value);
    if (list(node['@type']).some(type => typeof type === 'string' && /(?:^|\/)(?:ScholarlyArticle|MedicalScholarlyArticle)$/.test(type))) found.push(node);
    if (node['@graph']) visit(node['@graph'], depth + 1);
    if (node.mainEntity) visit(node.mainEntity, depth + 1);
  };
  for (const script of tags(html, 'script')) {
    if (script.attrs.type?.toLowerCase() !== 'application/ld+json') continue;
    const closing = html.toLowerCase().indexOf('</script', script.end);
    if (closing < 0) continue;
    try { visit(JSON.parse(html.slice(script.end, closing).trim())); } catch { /* Other article fields may still be valid. */ }
  }
  return found;
}
export interface PublisherArticle {
  abstract?: string; abstractKind?: 'citation_abstract' | 'dc.description' | 'jsonld' | 'section';
  doi?: string; pdfUrls: string[]; isOa: boolean; license?: string; oaEvidence?: string;
}

/** Generic description/OpenGraph fields never qualify as an author abstract. */
export function parsePublisherHtml(html: string, pageUrl: string, journalId: string): PublisherArticle {
  const url = httpsUrl(pageUrl);
  if (!url || !isOfficial(url, journalId)) throw new Error('Publisher page is outside the journal’s official domains');
  const metadata = new Map<string, string[]>();
  for (const { attrs } of tags(html, 'meta')) {
    const name = (attrs.name ?? attrs.property ?? '').toLowerCase();
    if (name && attrs.content) metadata.set(name, [...(metadata.get(name) ?? []), attrs.content]);
  }
  const first = (...names: string[]) => names.flatMap(name => metadata.get(name) ?? []).find(Boolean);
  const metadataDoi = normalizeDoi(first('citation_doi', 'prism.doi', 'dc.identifier', 'dc.identifier.doi'));
  const expectedDoi = metadataDoi ?? normalizeDoi(new URL(url).pathname);
  const scholarly = scholarlyNodes(html);
  const articleNodes = scholarly.filter(node => {
    const nodeDoi = normalizeDoi(node.identifier ?? node['@id']);
    if (expectedDoi && nodeDoi && expectedDoi !== nodeDoi) return false;
    if (scholarly.length === 1) return true;
    if (expectedDoi && nodeDoi === expectedDoi) return true;
    const nodeUrl = httpsUrl(node.url ?? node['@id'] ?? object(node.mainEntityOfPage)['@id'], url);
    if (nodeUrl && new URL(nodeUrl).pathname === new URL(url).pathname) return true;
    const headline = text(node.headline ?? node.name);
    return Boolean(headline && headline.toLowerCase() === first('citation_title')?.toLowerCase());
  });
  const doi = metadataDoi ?? articleNodes.map(node => normalizeDoi(node.identifier ?? node['@id'])).find(Boolean);
  const candidates: Array<{ value: string; kind: PublisherArticle['abstractKind'] }> = [];
  const addAbstract = (value: unknown, kind: PublisherArticle['abstractKind']) => { const candidate = abstractText(value); if (candidate) candidates.push({ value: candidate, kind }); };
  const articleIdentity = Boolean(doi || first('citation_title') || articleNodes.length || /\/(?:doi\/(?:abs\/|full\/)?10\.|science\/article\/|article\/view\/\d+)/i.test(new URL(url).pathname));
  for (const value of metadata.get('citation_abstract') ?? []) if (articleIdentity) addAbstract(value, 'citation_abstract');
  if (articleIdentity) for (const value of [...(metadata.get('dc.description') ?? []), ...(metadata.get('dc:description') ?? []), ...(metadata.get('dcterms.abstract') ?? [])]) addAbstract(value, 'dc.description');
  for (const node of articleNodes) addAbstract(node.abstract, 'jsonld');
  const visible = html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '').replace(/<!--[\s\S]*?-->/g, '');
  if (articleIdentity) for (const tag of ['section', 'div']) for (const entry of tags(visible, tag)) {
    const identity = (entry.attrs.id ?? '') + ' ' + (entry.attrs.class ?? '');
    if (!/(?:^|\s|[_-])abstract(?:$|\s|[_-])|\babstractSection\b|\babstractInFull\b/i.test(identity) || /graphical|graphicalabstract|keywords|toc/i.test(identity)) continue;
    const body = sectionBody(visible, tag, entry.end);
    if (body) addAbstract(body, 'section');
  }
  candidates.sort((a, b) => b.value.length - a.value.length);
  const pdfUrls = new Set<string>();
  const addPdf = (candidate: unknown) => { const link = httpsUrl(candidate, url); if (link) pdfUrls.add(link); };
  for (const value of metadata.get('citation_pdf_url') ?? []) addPdf(value);
  let license = ccLicense(first('dc.rights', 'dc.rights.uri', 'dcterms.license', 'citation_license', 'dc:rights'));
  let oaEvidence = license ? 'Publisher Creative Commons licence metadata' : undefined;
  for (const link of tags(visible, 'link')) if (link.attrs.rel?.toLowerCase().split(/\s+/).includes('license')) {
    const found = ccLicense(link.attrs.href); if (found) { license = found; oaEvidence = 'Publisher licence link'; }
  }
  for (const node of articleNodes) {
    const found = ccLicense(node.license);
    if (found) { license = found; oaEvidence = 'ScholarlyArticle licence'; }
    if (node.isAccessibleForFree === true || node.isAccessibleForFree === 'true') oaEvidence ??= 'ScholarlyArticle isAccessibleForFree';
    for (const value of list(node.encoding)) {
      const encoding = object(value);
      if (encoding.encodingFormat === 'application/pdf' || /\.pdf(?:$|\?)/i.test(String(encoding.contentUrl ?? ''))) addPdf(encoding.contentUrl);
    }
  }
  if (/^(?:true|1|yes|open access)$/i.test(first('citation_open_access', 'dc.rights.accessrights') ?? '')) oaEvidence ??= 'Publisher open-access metadata';
  for (const anchor of tags(visible, 'a')) {
    const href = httpsUrl(anchor.attrs.href, url);
    if (!href) continue;
    const body = sectionBody(visible, 'a', anchor.end);
    if (/\/doi\/(?:pdf|epdf)\/|\/article\/download\/|\.pdf(?:$|\?)|\/pdfft(?:$|\?)/i.test(href) && (/(?:\bPDF\b|download)/i.test(cleanText(body ?? '')) || anchor.attrs.type === 'application/pdf')) addPdf(href);
    if ((anchor.attrs.rel ?? '').toLowerCase().split(/\s+/).includes('license') || /(?:article|doi).*(?:license|licence|rights)|(?:license|licence|rights).*(?:article|doi)/i.test((anchor.attrs.class ?? '') + ' ' + (anchor.attrs.id ?? ''))) {
      const found = ccLicense(href); if (found && articleIdentity) { license = found; oaEvidence = 'Publisher article rights link'; }
    }
  }
  for (const tag of ['span', 'div']) for (const entry of tags(visible, tag)) {
    if (!/(?:access[-_]?type|article[-_]?access|open[-_]?access|doi[-_]?access)/i.test((entry.attrs.class ?? '') + ' ' + (entry.attrs.id ?? ''))) continue;
    const label = cleanText(sectionBody(visible, tag, entry.end) ?? '').replace(/\s+/g, ' ').trim();
    if (/^(?:open access|open access article|full open access)$/i.test(label)) oaEvidence ??= 'Publisher article open-access badge';
  }
  if (journalId === 'jla' && articleIdentity) {
    oaEvidence ??= 'JLA immediate open-access policy';
    const date = first('citation_publication_date', 'dc.date', 'dc.date.issued');
    if (!license && date && date.replace(/\//g, '-') >= '2024-12') license = 'https://creativecommons.org/licenses/by/4.0/';
  }
  return { abstract: candidates[0]?.value, abstractKind: candidates[0]?.kind, doi, pdfUrls: [...pdfUrls], isOa: Boolean(oaEvidence && articleIdentity), license, oaEvidence };
}

export function reconstructAbstract(index: Record<string, number[]> | null | undefined): string | undefined {
  if (!index || typeof index !== 'object' || Array.isArray(index)) return undefined;
  const words: string[] = [];
  for (const [word, positions] of Object.entries(index)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) if (Number.isInteger(position) && position >= 0 && position < 50000) words[position] = word;
  }
  const abstract=words.length ? words.join(' ').replace(/\s+/g, ' ').trim() : undefined;
  return abstract&&!isAvailabilityNote(abstract)?abstract:undefined;
}
export function isAvailabilityNote(value:string) {
 return /^(?:contains\s+full\s*text\s*:|full\s*text\s+(?:is\s+)?available(?:\s+at|\s*:|\s+from)|(?:no\s+)?abstract\s+(?:is\s+)?(?:not\s+available|unavailable)|download\s+(?:the\s+)?full\s*text\s*(?:here|:))/i.test(value.trim());
}
function publisherUrl(paper: Paper): string | undefined {
  const candidates = [paper.url, ...paper.aliases.filter(alias => alias.startsWith('url:')).map(alias => alias.slice(4)), ...paper.oaLocations.map(location => location.url)];
  for (const candidate of candidates) {
    const url = httpsUrl(candidate);
    if (url && isOfficial(url, paper.journalId) && !/\/doi\/(?:pdf|epdf)\/|\/article\/download\/|\.pdf(?:$|\?)|\/pdfft(?:$|\?)/i.test(url)) return url;
  }
  if (['bjet', 'berj'].includes(paper.journalId) && paper.doi) return 'https://bera-journals.onlinelibrary.wiley.com/doi/abs/' + encodeURI(paper.doi);
  if (paper.journalId === 'rer' && paper.doi) return 'https://journals.sagepub.com/doi/abs/' + encodeURI(paper.doi);
  if (['compedu', 'edurev', 'caeai'].includes(paper.journalId) && paper.pii) return 'https://www.sciencedirect.com/science/article/pii/' + encodeURIComponent(paper.pii);
  return undefined;
}
async function boundedHtml(response: Response): Promise<string> {
  const limit = 5 * 1024 * 1024;
  if (Number(response.headers.get('content-length')) > limit) { await response.body?.cancel(); throw new Error('Publisher HTML exceeds 5 MB'); }
  if (!response.body) return '';
  const reader = response.body.getReader(); const decoder = new TextDecoder();
  let bytes = 0; let html = '';
  try {
    while (true) {
      const chunk = await reader.read(); if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > limit) { await reader.cancel(); throw new Error('Publisher HTML exceeds 5 MB'); }
      html += decoder.decode(chunk.value, { stream: true });
    }
    return html + decoder.decode();
  } finally { reader.releaseLock(); }
}
function mergeLocation(paper: Paper, incoming: OALocation): void {
  const match = paper.oaLocations.find(location => (location.pdfUrl ?? location.url) === (incoming.pdfUrl ?? incoming.url));
  if (match) Object.assign(match, incoming); else paper.oaLocations.push(incoming);
}

/** A factory instance holds the access-block cache for one collection run. */
export function createPaperEnricher(request: Requester = fetchRemote) {
  const blocked = new Map<string, string>();
  const hostKey = (url: string) => new URL(url).hostname.replace(/^www\./, '').replace(/^bera-journals\./, '');
  const checkedRequest = async (url: string, init?: RequestInit): Promise<Response> => {
    const key = hostKey(url);
    if (blocked.has(key)) throw new Error(key + ': access blocked earlier in this run; request skipped');
    try {
      const response = await request(url, init);
      if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP ' + response.status); }
      return response;
    } catch (error) {
      const message = safeError(error);
      if (/\b(?:401|403|429)\b/.test(message)) blocked.set(key, message);
      throw error;
    }
  };
  return async function enrich(paper: Paper): Promise<string[]> {
    const errors: string[] = []; const now = new Date().toISOString();
    let oaLookupSucceeded = false;
    const publisher = publisherUrl(paper);
    if (publisher) {
      try {
        const response = await checkedRequest(publisher, { headers: { Accept: 'text/html,application/xhtml+xml;q=0.9' } });
        const finalUrl = response.url || publisher;
        if (!isOfficial(finalUrl, paper.journalId)) { await response.body?.cancel(); throw new Error('Publisher redirected outside the journal’s official domains'); }
        const contentType = response.headers.get('content-type') ?? '';
        if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) { await response.body?.cancel(); throw new Error('Publisher returned a non-HTML response'); }
        const html = await boundedHtml(response);
        if (/<title[^>]*>\s*(?:Just a moment|Attention Required|Access Denied|Security check)|\bcf-chl-(?:opt|widget|managed)/i.test(html)) {
          blocked.set(hostKey(publisher), 'Publisher access challenge');
          throw new Error('Publisher access challenge; further requests to this host are skipped this run');
        }
        const article = parsePublisherHtml(html, finalUrl, paper.journalId);
        if (paper.doi && article.doi && normalizeDoi(paper.doi) !== article.doi) throw new Error('Publisher DOI does not match the requested article');
        oaLookupSucceeded = true;
        if (!paper.doi && article.doi) { paper.doi = article.doi; paper.aliases = [...new Set([...paper.aliases, 'doi:' + article.doi])]; }
        if (article.abstract && (!paper.abstract || article.abstract.length >= paper.abstract.length || /api\.(?:openalex|crossref)\.org/i.test(paper.abstractSource ?? ''))) {
          paper.abstract = article.abstract; paper.abstractSource = finalUrl;
        }
        if (article.isOa) for (const pdfUrl of article.pdfUrls.length ? article.pdfUrls : [undefined]) mergeLocation(paper, { url: finalUrl, pdfUrl, hostType: 'publisher', version: 'publishedVersion', license: article.license, isOa: true, source: finalUrl });
        paper.provenance = paper.provenance.filter(value => !(value.source === 'publisher-html' && value.url === finalUrl));
        paper.provenance.push({ source: 'publisher-html', url: finalUrl, fetchedAt: now });
      } catch (error) { errors.push('Publisher: ' + safeError(error)); }
    }
    if (!paper.abstract && process.env.ELSEVIER_API_KEY && ['compedu', 'edurev', 'caeai'].includes(paper.journalId) && (paper.pii || paper.doi)) {
      try {
        const url = 'https://api.elsevier.com/content/article/' + (paper.pii ? 'pii/' + encodeURIComponent(paper.pii) : 'doi/' + encodeURIComponent(paper.doi!)) + '?view=META_ABS&httpAccept=application/json';
        const data = object(await (await checkedRequest(url, { headers: { 'X-ELS-APIKey': process.env.ELSEVIER_API_KEY, Accept: 'application/json' } })).json());
        const core = object(object(data['full-text-retrieval-response']).coredata);
        const abstract = text(core['dc:description']);
        if (abstract) { paper.abstract = abstract; paper.abstractSource = url; }
        paper.provenance.push({ source: 'elsevier', url, fetchedAt: now });
      } catch (error) { errors.push('Elsevier: ' + safeError(error)); }
    }
    if (paper.doi) {
      try {
        const source = 'https://api.openalex.org/works/https://doi.org/' + encodeURIComponent(paper.doi);
        const url = new URL(source); if (process.env.OPENALEX_API_KEY) url.searchParams.set('api_key', process.env.OPENALEX_API_KEY);
        const data = object(await (await checkedRequest(url.href, { headers: { Accept: 'application/json' } })).json());
        oaLookupSucceeded = true;
        if (!paper.abstract) { const abstract = reconstructAbstract(data.abstract_inverted_index as Record<string, number[]> | undefined); if (abstract) { paper.abstract = abstract; paper.abstractSource = source; } }
        if (!paper.keywords.length && Array.isArray(data.keywords)) paper.keywords = data.keywords.map(value => text(object(value).display_name)).filter((value): value is string => Boolean(value));
        for (const value of [data.best_oa_location, ...list(data.locations)]) {
          const location = object(value); if (location.is_oa !== true) continue;
          const landing = httpsUrl(location.landing_page_url) ?? httpsUrl(location.pdf_url); if (!landing) continue;
          mergeLocation(paper, { url: landing, pdfUrl: httpsUrl(location.pdf_url), hostType: object(location.source).type === 'repository' ? 'repository' : 'publisher', version: text(location.version), license: text(location.license), isOa: true, source });
        }
        paper.provenance = paper.provenance.filter(value => value.source !== 'openalex');
        paper.provenance.push({ source: 'openalex', url: source, fetchedAt: now });
      } catch (error) { errors.push('OpenAlex: ' + safeError(error)); }
    }
    const directOaPdf = paper.oaLocations.some(location => location.isOa && location.pdfUrl);
    if (directOaPdf && paper.pdf.status === 'unavailable') paper.pdf = { status: 'pending' };
    else if (oaLookupSucceeded && !directOaPdf && paper.pdf.status === 'pending') paper.pdf = {
      status: 'unavailable', attemptedAt: now,
      error: paper.oaLocations.some(location => location.isOa) ? 'An open-access landing page was found, but no verified direct PDF is available.' : 'No open-access PDF location was established by the metadata sources checked.',
    };
    paper.updatedAt = now;
    return errors;
  };
}
export const enrichPaper = createPaperEnricher();
