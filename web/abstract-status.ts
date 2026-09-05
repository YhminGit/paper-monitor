import type { Paper } from '../src/types';

export interface AbstractCoverage {
  papers: number; available: number; missing: number; summaries: number;
  attempted: number; partial: number; notFound: number; noRecordedCheck: number;
  missingWithoutRecordedCheck: number; lastCheckedAt?: string;
}
export interface PublicAbstractCoverage { papers: number; licensed: number; withheld: number; unavailable: number; summaries: number; }

/** These labels distinguish absence of recorded history from a known failed check. */
export function abstractPresentation(paper: Paper, publicMode: boolean) {
  if (publicMode) {
    if (paper.publicContent?.abstract === 'withheld') return {
      kind: 'withheld' as const, label: 'Abstract withheld from public view',
      description: 'The author abstract is not reproduced here because redistribution permission has not been confirmed. This does not mean the abstract is unavailable at the publisher.',
    };
    if (paper.publicContent?.abstract === 'licensed' && paper.abstract?.trim()) return {
      kind: 'available' as const, label: 'Licensed author abstract',
      description: 'The author abstract is reproduced under the recorded redistribution licence.',
    };
    return { kind: 'unavailable' as const, label: 'Abstract unavailable in this snapshot', description: 'No author abstract was published in this snapshot. The publisher may offer an abstract or other reading options.' };
  }
  if (paper.abstract?.trim()) return { kind: 'available' as const, label: 'Author abstract available', description: 'The author abstract is available in the local archive.' };
  if (!paper.abstractRetrieval) return {
    kind: 'unavailable' as const, label: 'No recorded abstract check',
    description: 'No abstract-check history is recorded for this paper. Older retrieval attempts may predate this history.',
  };
  if (paper.abstractRetrieval.status === 'partial') return {
    kind: 'unavailable' as const, label: 'Abstract retrieval incomplete',
    description: 'One or more sources could not be checked successfully. The author abstract is still missing.',
  };
  if (paper.abstractRetrieval.status === 'not-found') return {
    kind: 'unavailable' as const, label: 'Author abstract not found',
    description: 'The recorded source check completed without locating an author abstract.',
  };
  return { kind: 'unavailable' as const, label: 'Author abstract currently unavailable', description: 'An earlier check recorded an abstract, but its text is not present in the current archive.' };
}

export function publicAbstractCoverage(papers: readonly Paper[]): PublicAbstractCoverage {
  const licensed = papers.filter(paper => abstractPresentation(paper, true).kind === 'available').length;
  const withheld = papers.filter(paper => abstractPresentation(paper, true).kind === 'withheld').length;
  return { papers: papers.length, licensed, withheld, unavailable: papers.length - licensed - withheld, summaries: papers.filter(paper => Boolean(paper.summary?.trim())).length };
}
