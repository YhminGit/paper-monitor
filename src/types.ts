export type Topic = 'both' | 'learning-analytics' | 'ai' | 'unrelated' | 'pending';
export interface Journal { id: string; name: string; shortName: string; issn: string; publisher: 'wiley' | 'elsevier' | 'jla' | 'sage'; url: string; feeds: string[]; }
export interface PaperDate { value: string; precision: 'day' | 'month' | 'year'; source: string; }
export interface Provenance { source: string; url: string; fetchedAt: string; }
export interface Relevance { topic: Topic; method: 'rules' | 'codex'; confidence: 'high' | 'medium' | 'low'; reason: string; evidence: string[]; reviewedAt?: string; reviewedFingerprint?: string; }
export interface OALocation { url: string; pdfUrl?: string; hostType: 'publisher' | 'repository'; version?: string; license?: string; isOa: boolean; source: string; }
export interface PdfRecord { status: 'pending' | 'downloaded' | 'unavailable' | 'blocked' | 'failed'; path?: string; sourceUrl?: string; sha256?: string; bytes?: number; license?: string; version?: string; error?: string; attemptedAt?: string; }
export interface Milestone { kind: 'online' | 'issue' | 'backfill'; observedAt: string; date?: string; runId?: string; }
export interface Paper {
  id: string; doi?: string; pii?: string; aliases: string[]; journalId: string; title: string; authors: string[];
  url: string; keywords: string[]; articleType: string; abstract?: string; abstractSource?: string;
  summary?: string; summarySource?: string; summaryGeneratedAt?: string;
  publicContent?: { abstract:'licensed'|'withheld'|'unavailable'; license?:string };
  publishedOnline?: PaperDate; publishedIssue?: PaperDate; publicationDate?: PaperDate;
  volume?: string; issue?: string; pages?: string; firstSeenAt: string; updatedAt: string;
  relevance: Relevance; oaLocations: OALocation[]; pdf: PdfRecord; milestones: Milestone[]; provenance: Provenance[];
}
export interface SourceHealth { journalId: string; status: 'ok' | 'partial' | 'failed' | 'never'; checkedAt?: string; lastSuccessAt?: string; discovered: number; errors: string[]; }
export interface Library { schemaVersion: 1; generatedAt: string; coverageStart: string; journals: Journal[]; papers: Paper[]; sources: SourceHealth[]; lastRunId?: string; }
export interface ReviewDecision { paperId: string; topic: Topic; reason: string; evidence: string[]; confidence: 'high' | 'medium' | 'low'; summary?: string; }
export interface ReviewRequest { schemaVersion: 1; runId: string; instructions: string; papers: Array<{ paper: Paper; textPath?: string; needsSummary: boolean }>; }
export interface RunReport { schemaVersion: 1; id: string; startedAt: string; finishedAt?: string; status: 'collected' | 'finalized'; coverageStart: string; backfill: boolean; papers: Paper[]; sources: SourceHealth[]; notifications: Array<{ paperId: string; kind: Milestone['kind'] }>; warnings: string[]; }
