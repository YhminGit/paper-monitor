import type { Library, Paper } from '../src/types';
import { parseSearch, searchPapers, type SearchResult } from '../src/search';

export const PUBLIC_MODE = import.meta.env.VITE_PUBLIC_LIBRARY === 'true';
export const HOME_URL = import.meta.env.BASE_URL.endsWith('/') ? import.meta.env.BASE_URL : `${import.meta.env.BASE_URL}/`;
export const DIGEST_URL = PUBLIC_MODE ? `${HOME_URL}data/latest.md` : '/api/reports/latest';
export type PublicPaper = Paper & { publicContent?: { abstract: 'licensed' | 'withheld' | 'unavailable'; license?: string } };
export type Status = Omit<Library, 'papers'> & {
  paperCount: number;
  credentials?: { elsevier: boolean; openalex: boolean; contactEmail: boolean };
  snapshotError?: string;
  contentCounts?: { abstracts: number; summaries: number; pdfs: number; missingAbstracts: number; pdfQueued: number; oaLinks?: number; withheldAbstracts?: number };
};
export type Results = SearchResult;

export function safeUrl(value?: string): string | undefined {
  try {
    const url = new URL(value || '');
    return ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

/** An OA flag and an actual external location are both required; local PDF state is never used. */
export function openAccessUrl(paper: Paper): string | undefined {
  for (const location of paper.oaLocations) {
    if (!location.isOa) continue;
    const href = safeUrl(location.url) || safeUrl(location.pdfUrl);
    if (href) return href;
  }
  return undefined;
}

async function fetchJson<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await fetch(url, { signal, cache: 'no-cache' });
  const body = await response.json().catch(() => ({ error: 'The library returned an unreadable response.' }));
  if (!response.ok || body.error) throw new Error(body.error || `Request failed (${response.status}).`);
  return body as T;
}

let snapshot: Library | undefined;
let snapshotRequest: Promise<Library> | undefined;
async function publicSnapshot(signal?: AbortSignal, refresh = false): Promise<Library> {
  if (!refresh && snapshot) {
    if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
    return snapshot;
  }
  if (!snapshotRequest && (!snapshot || refresh)) {
    // Do not attach one component's abort signal to the shared fetch (including React StrictMode).
    snapshotRequest = fetchJson<Library>(`${HOME_URL}data/library.json`).then(next => {
      if (next.schemaVersion !== 1 || !Array.isArray(next.papers) || !Array.isArray(next.journals) || !Array.isArray(next.sources) || !next.generatedAt || !next.coverageStart) {
        throw new Error('The published library snapshot is invalid. Please try again after the next publication.');
      }
      snapshot = next;
      return next;
    }).finally(() => { snapshotRequest = undefined; });
  }
  const library = await (snapshotRequest || Promise.resolve(snapshot!));
  if (signal?.aborted) throw new DOMException('Request cancelled', 'AbortError');
  return library;
}

export async function loadStatus(signal?: AbortSignal): Promise<Status> {
  if (!PUBLIC_MODE) return fetchJson<Status>('/api/status', signal);
  const { papers, ...metadata } = await publicSnapshot(signal, true);
  return {
    ...metadata, paperCount: papers.length,
    contentCounts: {
      abstracts: papers.filter(paper => Boolean(paper.abstract)).length,
      summaries: papers.filter(paper => Boolean(paper.summary)).length,
      pdfs: 0, pdfQueued: 0,
      missingAbstracts: papers.filter(paper => !paper.abstract).length,
      oaLinks: papers.filter(paper => Boolean(openAccessUrl(paper))).length,
      withheldAbstracts: papers.filter(paper => (paper as PublicPaper).publicContent?.abstract === 'withheld').length,
    },
  };
}

export async function loadPapers(query: string, signal?: AbortSignal): Promise<Results> {
  if (!PUBLIC_MODE) return fetchJson<Results>(`/api/papers?${query}`, signal);
  const filters = parseSearch(new URLSearchParams(query));
  const library = await publicSnapshot(signal);
  // Keep bookmarked filter values compatible while applying the public OA-link meaning.
  const papers = filters.pdf === 'any' ? library.papers : library.papers.filter(paper => Boolean(openAccessUrl(paper)) === (filters.pdf === 'downloaded'));
  return searchPapers(papers, { ...filters, pdf: 'any' });
}

export async function loadPaper(id: string, signal?: AbortSignal): Promise<PublicPaper> {
  if (!PUBLIC_MODE) return fetchJson<Paper>(`/api/papers/${encodeURIComponent(id)}`, signal);
  const library = await publicSnapshot(signal);
  const paper = library.papers.find(item => item.id === id);
  if (!paper) throw new Error('This paper is not in the published snapshot. Return to the library to browse available papers.');
  return paper;
}
