import { JOURNALS } from './config.js';
import { fetchRemote, safeError } from './http.js';
import { mergePaper } from './identity.js';
import { cleanText, parseCrossrefWork } from './sources.js';
import type { Journal, Paper } from './types.js';

type Data = Record<string, unknown>;
const object = (value: unknown): Data => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Data : {};
const list = (value: unknown): unknown[] => Array.isArray(value) ? value : value === undefined || value === null ? [] : [value];
const issnKey = (value: unknown): string => typeof value === 'string' ? value.trim().replace(/-/g, '').toUpperCase() : '';
function piiKey(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().replace(/^pii:\s*/i, '').replace(/[-()]/g, '').toUpperCase();
  return /^S[0-9X]{16}$/.test(normalized) ? normalized : undefined;
}
function exactDoi(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let doi = value.trim().replace(/^(?:https?:\/\/(?:dx\.)?doi\.org\/|doi:\s*)/i, '');
  try { doi = decodeURIComponent(doi); } catch { return undefined; }
  return /^10\.\d{4,9}\/[^\s<>"?#]+$/i.test(doi) ? doi.toLowerCase() : undefined;
}
function titleKey(value: string): string {
  // Typography/HTML and case may vary between RSS and Crossref. Do not use a
  // similarity score, a title prefix, or punctuation-stripped word fragments.
  return cleanText(value).normalize('NFKC').replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/[‐‑‒–—−]/g, '-').replace(/\s+/g, ' ').trim().toLowerCase();
}

interface Lookup { items?: unknown[]; error?: string; fetchedAt: string }
function matchedPaper(items: unknown[], paper: Paper, journal: Journal, pii: string, now: string): Paper {
  if (!items.length) throw new Error('No Crossref record was returned for the exact PII');
  const candidates: Paper[] = [];
  for (const value of items) {
    const item = object(value);
    if (!list(item.ISSN).some(issn => issnKey(issn) === issnKey(journal.issn))) throw new Error('Crossref record does not match the configured journal ISSN');
    if (!list(item['alternative-id']).some(id => piiKey(id) === pii)) throw new Error('Crossref record does not contain the exact requested PII');
    const doi = exactDoi(item.DOI);
    if (!doi) throw new Error('Crossref record has no valid exact DOI');
    const candidate = parseCrossrefWork(value, journal, now);
    if (!candidate || candidate.doi !== doi || piiKey(candidate.pii) !== pii) throw new Error('Crossref bibliographic identity could not be verified');
    candidates.push(candidate);
  }
  if (new Set(candidates.map(candidate => candidate.doi)).size !== 1) throw new Error('Multiple DOIs match the PII; identifier recovery is ambiguous');
  const title = titleKey(paper.title);
  if (!title || candidates.some(candidate => titleKey(candidate.title) !== title)) throw new Error('Crossref full title does not exactly match the RSS title');
  // mergePaper keeps the original stable ID, review, downloads, summaries, first
  // observation, and milestones. Crossref dates retain their supplied precision;
  // a future issue date must not be converted into an invented online date.
  return candidates.reduce((merged, candidate) => mergePaper(merged, candidate), paper);
}

/** Resolve missing Elsevier RSS DOIs without changing any inputs or archive files. */
export async function recoverIdentifiers(papers: Paper[], request: typeof fetchRemote = fetchRemote): Promise<{ papers: Paper[]; errors: string[] }> {
  const recovered: Paper[] = [], errors: string[] = [];
  const cache = new Map<string, Lookup>();
  let blocked = false;
  for (const paper of papers) {
    const journal = JOURNALS.find(journal => journal.id === paper.journalId && journal.publisher === 'elsevier');
    if (paper.doi || !journal) { recovered.push(paper); continue; }
    try {
      const pii = piiKey(paper.pii);
      if (!pii) throw new Error('No valid Elsevier PII is available for exact DOI recovery');
      if (pii.slice(1, 9) !== issnKey(journal.issn)) throw new Error('The PII serial identifier does not match the configured journal');
      const key = journal.id + ':' + pii;
      let lookup = cache.get(key);
      if (!lookup) {
        const fetchedAt = new Date().toISOString();
        if (blocked) lookup = { fetchedAt, error: 'Crossref access was blocked earlier in this run; identifier lookup skipped' };
        else {
          try {
            // This is an exact identifier filter, not query.bibliographic:
            // https://www.crossref.org/documentation/retrieve-metadata/rest-api/rest-api-filters/
            const url = new URL('https://api.crossref.org/journals/' + encodeURIComponent(journal.issn) + '/works');
            url.searchParams.set('filter', 'alternative-id:' + pii);
            url.searchParams.set('rows', '5');
            const response = await request(url.href, { headers: { Accept: 'application/json' } });
            if (!response.ok) { await response.body?.cancel(); throw new Error('HTTP ' + response.status); }
            const message = object(object(await response.json()).message), items = message.items, count = message['total-results'];
            if (!Array.isArray(items) || !Number.isInteger(count) || (count as number) < 0 || count !== items.length) throw new Error('Crossref result envelope is missing or incomplete; uniqueness cannot be verified');
            lookup = { items, fetchedAt };
          } catch (error) {
            const message = safeError(error);
            if (/\b(?:401|403|429)\b/.test(message)) blocked = true;
            lookup = { fetchedAt, error: message };
          }
        }
        cache.set(key, lookup);
      }
      if (lookup.error || !lookup.items) throw new Error(lookup.error ?? 'Crossref metadata was unavailable');
      recovered.push(matchedPaper(lookup.items, paper, journal, pii, lookup.fetchedAt));
    } catch (error) {
      recovered.push(paper);
      errors.push('Identifier recovery [' + safeError(paper.id).slice(0, 120) + ']: ' + safeError(error));
    }
  }
  return { papers: recovered, errors };
}
