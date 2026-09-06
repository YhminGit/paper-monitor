import type { Paper, PaperDate, Topic } from './types.js';

export const PAGE_SIZE = 25;
export interface SearchFilters {
  name: string;
  keywords: string;
  from?: string;
  to?: string;
  journals: string[];
  topics: Topic[];
  pdf: 'any' | 'downloaded' | 'unavailable';
  abstract: 'any' | 'available';
  sort: 'newest' | 'oldest';
  page: number;
}
export interface SearchResult { papers: Paper[]; total: number; page: number; pageSize: number; totalPages: number; }
export class SearchInputError extends Error {}

/** Unknown portions of dates remain intervals, never invented exact publication days. */
export function dateInterval(value: string): { start: string; end: string } | undefined {
  const match = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(value);
  if (!match || Number(match[1]) < 1) return undefined;
  const year = Number(match[1]);
  if (!match[2]) return { start: `${match[1]}-01-01`, end: `${match[1]}-12-31` };
  const month = Number(match[2]);
  if (month < 1 || month > 12) return undefined;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  if (!match[3]) return { start: `${value}-01`, end: `${value}-${days}` };
  const day = Number(match[3]);
  if (day < 1 || day > days) return undefined;
  return { start: value, end: value };
}

export function effectiveDate(paper: Paper): PaperDate | undefined {
  return paper.publishedOnline ?? paper.publishedIssue ?? paper.publicationDate;
}

export function parseSearch(params: URLSearchParams): SearchFilters {
  const from = params.get('from')?.trim() || undefined;
  const to = params.get('to')?.trim() || undefined;
  if ((from && !dateInterval(from)) || (to && !dateInterval(to))) throw new SearchInputError('Dates must be valid YYYY-MM-DD, YYYY-MM, or YYYY values.');
  if (from && to && dateInterval(from)!.start > dateInterval(to)!.end) throw new SearchInputError('The start date must be on or before the end date.');
  const pageValue = params.get('page') || '1';
  if (!/^[1-9]\d*$/.test(pageValue) || !Number.isSafeInteger(Number(pageValue))) throw new SearchInputError('Page must be a positive integer.');
  if (params.has('pageSize') && params.get('pageSize') !== String(PAGE_SIZE)) throw new SearchInputError('Page size is fixed at 25.');
  const pdf = params.get('pdf') || 'any';
  if (!['any', 'downloaded', 'unavailable'].includes(pdf)) throw new SearchInputError('Unknown PDF availability filter.');
  const abstract = params.get('abstract') || 'any';
  if (!['any', 'available'].includes(abstract)) throw new SearchInputError('Unknown abstract availability filter.');
  const sort = params.get('sort') || 'newest';
  if (!['newest', 'oldest'].includes(sort)) throw new SearchInputError('Sort must be newest or oldest.');
  const topics = [...new Set(params.getAll('topic').filter(Boolean))];
  if (topics.some(topic => !['both', 'learning-analytics', 'ai'].includes(topic))) throw new SearchInputError('Unknown topic filter.');
  return {
    name: (params.get('name') || '').trim(), keywords: (params.get('keywords') || '').trim(), from, to,
    journals: [...new Set(params.getAll('journal').filter(Boolean))], topics: topics as Topic[],
    pdf: pdf as SearchFilters['pdf'], abstract: abstract as SearchFilters['abstract'], sort: sort as SearchFilters['sort'], page: Number(pageValue),
  };
}

const fold = (value: string) => value.normalize('NFKC').toLocaleLowerCase('en');

export function searchPapers(papers: readonly Paper[], filters: SearchFilters): SearchResult {
  const name = fold(filters.name);
  const keywords = fold(filters.keywords).split(/\s+/).filter(Boolean);
  const lower = filters.from ? dateInterval(filters.from)!.start : undefined;
  const upper = filters.to ? dateInterval(filters.to)!.end : undefined;
  const matches = papers.filter(paper => {
    if (!['both', 'learning-analytics', 'ai'].includes(paper.relevance.topic)) return false;
    if (name && ![paper.title, ...paper.authors].some(value => fold(value).includes(name))) return false;
    if (keywords.length) {
      const text = fold([paper.title, paper.abstract || '', ...paper.keywords, paper.summary || ''].join(' '));
      if (!keywords.every(keyword => text.includes(keyword))) return false;
    }
    if (filters.journals.length && !filters.journals.includes(paper.journalId)) return false;
    if (filters.topics.length && !filters.topics.includes(paper.relevance.topic)) return false;
    if (filters.pdf === 'downloaded' && paper.pdf.status !== 'downloaded') return false;
    if (filters.pdf === 'unavailable' && paper.pdf.status === 'downloaded') return false;
    // Availability means readable author text, not a summary or an off-site source link.
    if (filters.abstract === 'available' && (!paper.abstract?.trim() || (paper.publicContent && paper.publicContent.abstract !== 'licensed'))) return false;
    if (lower || upper) {
      const date = effectiveDate(paper);
      const interval = date && dateInterval(date.value);
      if (!interval || (lower && interval.end < lower) || (upper && interval.start > upper)) return false;
    }
    return true;
  });
  matches.sort((a, b) => {
    const aDate = effectiveDate(a);
    const bDate = effectiveDate(b);
    const aValue = aDate && dateInterval(aDate.value)?.start;
    const bValue = bDate && dateInterval(bDate.value)?.start;
    if (!aValue && bValue) return 1;
    if (aValue && !bValue) return -1;
    if (aValue && bValue && aValue !== bValue) return (filters.sort === 'newest' ? -1 : 1) * aValue.localeCompare(bValue);
    return a.title.localeCompare(b.title, 'en') || a.id.localeCompare(b.id);
  });
  const totalPages = Math.ceil(matches.length / PAGE_SIZE);
  const page = Math.min(filters.page, Math.max(1, totalPages));
  return { papers: matches.slice((page - 1) * PAGE_SIZE, page * PAGE_SIZE), total: matches.length, page, pageSize: PAGE_SIZE, totalPages };
}
