import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { Journal, Paper, PaperDate, SourceHealth, Topic } from '../src/types';
import { DIGEST_URL, HOME_URL, PUBLIC_MODE, loadPaper, loadPapers, loadStatus, openAccessUrl, safeUrl, type PublicPaper, type Results, type Status } from './data';
import { abstractPresentation, type AbstractCoverage, type PublicAbstractCoverage } from './abstract-status';
import './styles.css';
import './abstract-status.css';

type IconName = 'search' | 'arrow' | 'external' | 'download' | 'file' | 'check' | 'close' | 'filter' | 'chevron' | 'clock' | 'book' | 'refresh' | 'info';
const TOPICS: Array<{ id: Topic; label: string; short: string }> = [
  { id: 'both', label: 'Learning analytics + AI', short: 'Analytics + AI' },
  { id: 'learning-analytics', label: 'Learning analytics', short: 'Learning analytics' },
  { id: 'ai', label: 'Artificial intelligence', short: 'Artificial intelligence' },
];

function Icon({ name, size = 18, className = '' }: { name: IconName; size?: number; className?: string }) {
  const paths: Record<IconName, React.ReactNode> = {
    search: <><circle cx="10.7" cy="10.7" r="6.7" /><path d="m16 16 4.5 4.5" /></>,
    arrow: <><path d="M4 12h15M14 6l6 6-6 6" /></>,
    external: <><path d="M14 4h6v6M20 4l-9 9M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5" /></>,
    download: <><path d="M12 3v12m-5-5 5 5 5-5M5 16v4h14v-4" /></>,
    file: <><path d="M14 3H5v18h14V8zM14 3v5h5M8 12h8M8 16h5" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    close: <path d="m6 6 12 12M6 18 18 6" />,
    filter: <><path d="M4 6h16M4 12h16M4 18h16" /><circle cx="9" cy="6" r="2" /><circle cx="15" cy="12" r="2" /><circle cx="9" cy="18" r="2" /></>,
    chevron: <path d="m8 4 8 8-8 8" />,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
    book: <><path d="M12 5v15M12 5C8 2 3 4 3 4v15s5-2 9 1c4-3 9-1 9-1V4s-5-2-9 1Z" /></>,
    refresh: <><path d="M20 7v5h-5M4 17v-5h5M5.2 7a8 8 0 0 1 13-2L20 8M4 16l1.8 3a8 8 0 0 0 13-2" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v6M12 7h.01" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">{paths[name]}</svg>;
}

function formatDate(date?: PaperDate): string {
  if (!date?.value) return 'Date unavailable';
  const value = date.value;
  if (date.precision === 'year') return value.slice(0, 4);
  const parsed = new Date(`${value.slice(0, date.precision === 'month' ? 7 : 10)}${date.precision === 'month' ? '-01' : ''}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return parsed.toLocaleDateString('en-GB', { timeZone: 'UTC', day: date.precision === 'day' ? 'numeric' : undefined, month: 'short', year: 'numeric' });
}
function formatTimestamp(value?: string): string {
  if (!value) return 'Awaiting first collection';
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return 'Date unavailable';
  return parsed.toLocaleString('en-GB', { timeZone: 'Asia/Shanghai', day: 'numeric', month: 'short', year: PUBLIC_MODE ? 'numeric' : undefined, hour: '2-digit', minute: '2-digit', hour12: false });
}
function effectiveDate(paper: Paper) { return paper.publishedOnline || paper.publishedIssue || paper.publicationDate; }
function SourceLink({ value }: { value: string }) {
  const href = safeUrl(value);
  return href ? <a href={href} target="_blank" rel="noreferrer" style={{ textDecoration: 'underline', textUnderlineOffset: '3px' }}>{value} <Icon name="external" size={10} /></a> : <>{value}</>;
}
function chinaToday() { return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date()); }
function last30Days() { const date = new Date(`${chinaToday()}T00:00:00Z`); date.setUTCDate(date.getUTCDate() - 29); return date.toISOString().slice(0, 10); }

function useQuery() {
  const [query, setQuery] = useState(window.location.search);
  useEffect(() => { const handler = () => setQuery(window.location.search); window.addEventListener('popstate', handler); return () => window.removeEventListener('popstate', handler); }, []);
  const navigate = useCallback((change: (params: URLSearchParams) => void, resetPage = true) => {
    const params = new URLSearchParams(window.location.search);
    change(params);
    if (resetPage) params.delete('page');
    const suffix = params.toString();
    const next = suffix ? `?${suffix}` : window.location.pathname;
    if (next !== `${window.location.pathname}${window.location.search}` && `?${suffix}` !== window.location.search) {
      window.history.pushState({}, '', next);
      setQuery(window.location.search);
    }
  }, []);
  return { query, params: new URLSearchParams(query), navigate };
}

function SearchField({ id, label, placeholder, value, onApply }: { id: string; label: string; placeholder: string; value: string; onApply: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => { clearTimeout(timer.current); setDraft(value); }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const apply = (next: string) => { clearTimeout(timer.current); onApply(next.trim()); };
  return <div className="search-field"><label htmlFor={id}>{label}</label><div className="input-with-icon"><Icon name="search" size={19} /><input id={id} type="search" placeholder={placeholder} value={draft} onChange={event => { const next = event.target.value; setDraft(next); clearTimeout(timer.current); timer.current = setTimeout(() => apply(next), 400); }} onBlur={() => apply(draft)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); apply(draft); } }} /></div></div>;
}

function TopicBadge({ topic }: { topic: Topic }) {
  return <span className={`topic-badge ${topic}`}>{TOPICS.find(item => item.id === topic)?.short || 'Relevance under review'}</span>;
}

function PaperCard({ paper, journal, onOpen }: { paper: PublicPaper; journal?: Journal; onOpen: () => void }) {
  const abstract = abstractPresentation(paper, PUBLIC_MODE);
  const summary = abstract.kind !== 'available' && paper.summary;
  const snippet = abstract.kind === 'available' ? paper.abstract : paper.summary;
  const oaUrl = openAccessUrl(paper);
  return <article className="paper-card">
    <div className="paper-card-meta"><span className="journal-name">{journal?.name || paper.journalId}</span><span className="meta-divider">·</span><time>{formatDate(effectiveDate(paper))}</time></div>
    <h2><button className="paper-title" onClick={onOpen}>{paper.title}</button></h2>
    <p className="authors" title={paper.authors.join(', ')}>{paper.authors.length ? paper.authors.join(', ') : 'Authors unavailable'}</p>
    {summary && <span className="summary-note">AI-generated full-text summary</span>}
    {snippet && <p className="abstract-preview">{snippet}</p>}
    {(PUBLIC_MODE || !snippet) && <p className={`abstract-state-caption ${abstract.kind}`}><Icon name={abstract.kind === 'available' ? 'check' : 'info'} size={13} /><span>{abstract.label}.{abstract.kind !== 'available' && PUBLIC_MODE && safeUrl(paper.url) && <> <a href={safeUrl(paper.url)} target="_blank" rel="noreferrer">View at publisher <Icon name="external" size={12} /></a></>}</span></p>}
    <div className="paper-card-bottom"><div className="paper-tags"><TopicBadge topic={paper.relevance.topic} />{paper.relevance.method === 'rules' && <span className="topic-badge pending" title="Keyword-based relevance match awaiting semantic review">Provisional match</span>}{PUBLIC_MODE ? oaUrl ? <a className="pdf-ready" href={oaUrl} target="_blank" rel="noreferrer"><Icon name="external" size={14} /> Open-access link available</a> : <span className="pdf-muted"><Icon name="file" size={14} /> No verified OA link</span> : paper.pdf.status === 'downloaded' ? <a className="pdf-ready" href={`/api/papers/${encodeURIComponent(paper.id)}/pdf`} target="_blank" rel="noreferrer"><Icon name="file" size={14} /> PDF available</a> : <span className="pdf-muted"><Icon name="file" size={14} />{paper.pdf.status === 'pending' ? 'PDF queued' : 'PDF not downloaded'}</span>}</div><button className="read-paper" onClick={onOpen}>View paper <Icon name="arrow" size={17} /></button></div>
  </article>;
}

function SourceStatus({ source, journal, coverage }: { source?: SourceHealth; journal: Journal; coverage?: AbstractCoverage }) {
  const state = source?.status || 'never';
  return <div className="source-row"><span className={`status-dot ${state}`} /><div><strong>{journal.shortName}</strong><span>Discovery: {state === 'ok' ? 'successful' : state === 'partial' ? 'Source or metadata notices' : state === 'failed' ? 'check unsuccessful' : 'no recorded check'}{source?.lastSuccessAt ? ` · ${formatTimestamp(source.lastSuccessAt)} CST` : ''}</span>{coverage && <div className="journal-abstract-coverage"><span>Author abstracts: <b>{coverage.available} / {coverage.papers}</b> available · <b>{coverage.missing}</b> missing</span><span>{coverage.attempted} recorded checks · {coverage.partial} partial · {coverage.notFound} not found</span><span>{coverage.noRecordedCheck} with no recorded abstract check{coverage.missingWithoutRecordedCheck > 0 && ` (${coverage.missingWithoutRecordedCheck} missing)`}</span>{coverage.lastCheckedAt && <span>Latest abstract check: {formatTimestamp(coverage.lastCheckedAt)} CST</span>}</div>}{source?.errors?.length ? <details><summary>Discovery check details</summary><p className="source-error">{source.errors.join('\n')}</p></details> : null}</div></div>;
}

function PublicJournalCoverage({ journal, coverage }: { journal: Journal; coverage?: PublicAbstractCoverage }) {
  return <div className="source-row"><span className="status-dot ok" /><div><strong>{journal.shortName}</strong><span>{journal.name}</span>{coverage && <div className="journal-abstract-coverage"><span>{coverage.papers} published paper records</span><span>Abstracts: <b>{coverage.licensed}</b> licensed · <b>{coverage.withheld}</b> withheld · <b>{coverage.unavailable}</b> unavailable</span></div>}</div></div>;
}

function CoverageOverview({ status }: { status: Status }) {
  const local = status.abstractCoverage;
  const published = status.publicAbstractCoverage;
  if (PUBLIC_MODE && published) return <section className="abstract-coverage-overview" aria-label="Published abstract coverage"><div className="coverage-title"><h2>Published abstract coverage</h2><span>{published.papers.toLocaleString()} paper records</span></div><div className="coverage-numbers"><div><strong>{published.licensed.toLocaleString()}</strong><span>Licensed abstracts shown</span></div><div><strong>{published.withheld.toLocaleString()}</strong><span>Withheld from public view</span></div><div><strong>{published.unavailable.toLocaleString()}</strong><span>Abstract text unavailable</span></div></div><p>Withheld means permission to republish is unconfirmed—not that the publisher has no abstract. Missing abstract text and generated summaries are counted separately.</p></section>;
  if (!PUBLIC_MODE && local) return <section className="abstract-coverage-overview" aria-label="Local abstract retrieval coverage"><div className="coverage-title"><h2>Author abstract coverage</h2><span>Separate from article discovery</span></div><div className="coverage-numbers"><div><strong>{local.available.toLocaleString()}</strong><span>Author abstracts available</span></div><div><strong>{local.missing.toLocaleString()}</strong><span>Author abstracts missing</span></div><div><strong>{local.attempted.toLocaleString()}</strong><span>Recorded abstract checks</span></div></div><p>{local.partial.toLocaleString()} partial checks · {local.notFound.toLocaleString()} checks found no abstract · {local.noRecordedCheck.toLocaleString()} papers with no recorded abstract check. Older retrieval attempts may predate this history. A successful discovery check does not mean every abstract was retrieved.</p></section>;
  return null;
}

function AbstractContent({ paper }: { paper: PublicPaper }) {
  const abstract = abstractPresentation(paper, PUBLIC_MODE);
  return <>
    <section className="detail-section"><div className="section-heading"><h2>Abstract</h2><span className="section-index">01</span></div>
      {abstract.kind === 'available' ? <>
        <p className="abstract-state-caption available"><Icon name="check" size={14} />{abstract.label}</p>
        <p className="full-abstract">{paper.abstract}</p>
        <p className="provenance-caption">Author abstract
          {paper.abstractSource && <> · Source: <SourceLink value={paper.abstractSource} /></>}
          {PUBLIC_MODE && paper.publicContent?.license && <> · Licence: <SourceLink value={paper.publicContent.license} /></>}
          {PUBLIC_MODE && safeUrl(paper.publicContent?.licenseSource) && <> · <a href={safeUrl(paper.publicContent?.licenseSource)} target="_blank" rel="noreferrer">Licence evidence <Icon name="external" size={11} /></a></>}
        </p>
      </> : <div className="content-unavailable"><Icon name="file" size={25} /><div>
        <strong className="abstract-status-heading">{abstract.label}</strong><p>{abstract.description}</p>
        {!PUBLIC_MODE && paper.abstractRetrieval && <p className="abstract-check-time">Last recorded attempt: {formatTimestamp(paper.abstractRetrieval.checkedAt)} CST</p>}
        {!PUBLIC_MODE && paper.abstractRetrieval?.errors.length ? <details className="abstract-check-errors"><summary>Abstract source check notices</summary><ul>{paper.abstractRetrieval.errors.map((error, index) => <li key={index}>{error}</li>)}</ul></details> : null}
        <p className="abstract-retry-note">{PUBLIC_MODE ? 'Any retry and a new publication happen in the local monitor; browsing this snapshot does not retry sources.' : 'Missing abstracts are eligible for retry from public sources by the local monitor. Browsing does not trigger a new check.'}</p>
        {safeUrl(paper.url) && <a className="inline-source-link" href={safeUrl(paper.url)} target="_blank" rel="noreferrer">Read at the publisher <Icon name="external" size={13} /></a>}
      </div></div>}
    </section>
    {paper.summary && <details className="detail-section" open={abstract.kind !== 'available'}><summary className="relevance-reason" style={{ cursor: 'pointer', fontWeight: 600 }}>AI-generated full-text summary</summary><div className="summary-disclosure" style={{ marginTop: 18 }}><Icon name="info" size={18} /><span>AI-generated full-text summary—not the author abstract. Included in keyword searches.</span></div><p className="full-abstract">{paper.summary}</p><p className="provenance-caption">{(paper.summarySource || paper.pdf.sourceUrl) ? <>Based on <SourceLink value={(paper.summarySource || paper.pdf.sourceUrl)!} /></> : 'Full-text source unavailable.'}{paper.summaryGeneratedAt && <> · Generated {formatTimestamp(paper.summaryGeneratedAt)} CST</>}</p></details>}
  </>;
}

function PaperAccess({ paper }: { paper: Paper }) {
  const oaUrl = openAccessUrl(paper);
  const publisherUrl = safeUrl(paper.url) || (paper.doi ? `https://doi.org/${encodeURIComponent(paper.doi)}` : undefined);
  const locations = paper.oaLocations.filter(location => location.isOa && (safeUrl(location.url) || safeUrl(location.pdfUrl)));
  return <aside className="detail-aside"><div className="access-panel"><div className="access-icon"><Icon name="file" size={27} /></div><h2>Read the paper</h2>
    <p>{PUBLIC_MODE ? 'Read at the publisher or an open-access repository. Files are hosted by their original sources.' : paper.pdf.status === 'downloaded' ? 'The full text is saved in your library.' : paper.pdf.status === 'pending' ? 'The monitor is checking for an open copy.' : 'Visit the publisher for available reading options.'}</p>
    {!PUBLIC_MODE && paper.pdf.status === 'downloaded' && <><a className="primary-button" target="_blank" rel="noreferrer" href={`/api/papers/${encodeURIComponent(paper.id)}/pdf`}>Open PDF <Icon name="external" size={16} /></a><a className="secondary-button" href={`/api/papers/${encodeURIComponent(paper.id)}/pdf?download=1`}>Download PDF <Icon name="download" size={16} /></a></>}
    {publisherUrl && <a className={!PUBLIC_MODE && paper.pdf.status === 'downloaded' ? 'publisher-link' : 'primary-button'} href={publisherUrl} target="_blank" rel="noreferrer">{PUBLIC_MODE ? 'View at source' : 'Publisher page'} <Icon name="external" size={15} /></a>}
    {PUBLIC_MODE && oaUrl && <a className="secondary-button" href={oaUrl} target="_blank" rel="noreferrer">Open-access link <Icon name="external" size={15} /></a>}
    {paper.doi && <div className="doi-detail"><span>DOI</span><a href={`https://doi.org/${encodeURIComponent(paper.doi)}`} target="_blank" rel="noreferrer">{paper.doi}</a></div>}
    {!PUBLIC_MODE && (paper.pdf.license || paper.pdf.version) && <dl className="file-metadata">{paper.pdf.version && <><dt>Version</dt><dd>{paper.pdf.version}</dd></>}{paper.pdf.license && <><dt>Licence</dt><dd>{paper.pdf.license}</dd></>}</dl>}
    {!PUBLIC_MODE && paper.pdf.error && <details className="download-detail"><summary>Download status</summary><p>{paper.pdf.error}</p></details>}
    {PUBLIC_MODE && !oaUrl && <p className="provenance-caption">No verified open-access location is listed for this paper.</p>}
    </div>{locations.length > 0 && <div className="open-copies"><h3>Open-access locations</h3>{locations.map((location, i) => <a key={`${location.url}-${i}`} href={safeUrl(location.url) || safeUrl(location.pdfUrl)} target="_blank" rel="noreferrer"><span>{location.hostType === 'publisher' ? 'Publisher copy' : 'Repository copy'}<small>{[location.version, location.license].filter(Boolean).join(' · ')}</small></span><Icon name="external" size={15} /></a>)}</div>}</aside>;
}

function PaperDetail({ id, journals, onBack, backHref }: { id: string; journals: Journal[]; onBack: () => void; backHref: string }) {
  const [paper, setPaper] = useState<PublicPaper>();
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController(); setPaper(undefined); setError(''); window.scrollTo({ top: 0 });
    loadPaper(id, controller.signal).then(next => { if (!controller.signal.aborted) setPaper(next); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); });
    return () => controller.abort();
  }, [id]);
  useEffect(() => { if (paper) document.title = `${paper.title} — Paper Monitor`; return () => { document.title = 'Paper Monitor — Research Library'; }; }, [paper]);
  const journal = journals.find(item => item.id === paper?.journalId);
  return <main className="detail-layout" id="main-content"><a className="back-button" href={backHref} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); onBack(); } }}><Icon name="arrow" size={17} className="rotate" /> Back to library</a>
    {error ? <div className="empty-state" role="alert"><Icon name="info" size={32} /><h2>We couldn’t open this paper</h2><p>{error}</p><button className="primary-button" onClick={onBack}>Return to library</button></div> : !paper ? <div className="detail-skeleton" role="status" aria-label="Loading paper"><div className="skeleton-line small" /><div className="skeleton-line" /><div className="skeleton-line" /><div className="skeleton-line medium" /></div> : <>
      <div className="detail-heading"><div className="eyebrow">{journal?.name || paper.journalId}</div><h1>{paper.title}</h1><p className="detail-authors">{paper.authors.length ? paper.authors.join(' · ') : 'Authors unavailable'}</p><div className="detail-heading-bottom"><TopicBadge topic={paper.relevance.topic} /><span>{formatDate(effectiveDate(paper))}</span>{paper.volume && <span>Volume {paper.volume}{paper.issue ? `, issue ${paper.issue}` : ''}</span>}</div>{!paper.publishedOnline && paper.publishedIssue && <p className="relevance-reason">First-online date unavailable; the date shown is the issue date.</p>}</div>
      <div className="detail-columns"><div className="detail-main"><AbstractContent paper={paper} />
      <section className="detail-section"><div className="section-heading"><h2>{PUBLIC_MODE ? 'Why this paper is included' : 'Why it’s in your library'}</h2><span className="section-index">02</span></div><p className="relevance-reason">{paper.relevance.reason}</p>{paper.relevance.evidence.length > 0 && <div className="evidence-tags">{paper.relevance.evidence.map((item, i) => <span key={`${item}-${i}`}>{item}</span>)}</div>}<p className="provenance-caption">{paper.relevance.method === 'codex' ? 'Reviewed with Codex' : 'Topic-based matching'} · {paper.relevance.confidence} confidence</p></section>
      {paper.keywords.length > 0 && <section className="detail-section"><h2>Article keywords</h2><div className="keyword-tags">{paper.keywords.map((keyword, i) => <span key={`${keyword}-${i}`}>{keyword}</span>)}</div></section>}
      <section className="detail-section"><div className="section-heading"><h2>Publication history</h2><span className="section-index">03</span></div><ol className="timeline">{paper.publishedOnline && <li><strong>First published online</strong><span>{formatDate(paper.publishedOnline)}</span></li>}{paper.publishedIssue && <li><strong>Issue publication date</strong><span>{formatDate(paper.publishedIssue)}</span></li>}{paper.milestones.map((milestone, i) => <li key={`${milestone.kind}-${i}`}><strong>{milestone.kind === 'backfill' ? 'Added from the historical archive' : milestone.kind === 'online' ? 'Online publication discovered' : 'Issue publication discovered'}</strong><span>{formatTimestamp(milestone.observedAt)} CST</span></li>)}{!paper.milestones.length && <li><strong>Added to your library</strong><span>{formatTimestamp(paper.firstSeenAt)} CST</span></li>}</ol></section>
      </div><PaperAccess paper={paper} /></div>
    </>}
  </main>;
}

function App() {
  const { query, params, navigate } = useQuery();
  const [status, setStatus] = useState<Status>();
  const [statusError, setStatusError] = useState('');
  const [results, setResults] = useState<Results>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [refreshKey, setRefreshKey] = useState(0);
  const statusVersion = useRef<string | undefined>(undefined);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  useEffect(() => {
    if (!filtersOpen) return;
    const previous = document.activeElement as HTMLElement | null;
    const panel = document.querySelector<HTMLElement>('.filter-sidebar');
    const focusable = () => Array.from(panel?.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, a[href]') || []).filter(element => element.getClientRects().length > 0);
    focusable()[0]?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setFiltersOpen(false); return; }
      if (event.key !== 'Tab') return;
      const elements = focusable(); const first = elements[0]; const last = elements.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); previous?.focus(); };
  }, [filtersOpen]);
  const selectedPaper = params.get('paper');
  const listParams = new URLSearchParams(query); listParams.delete('paper'); listParams.set('pageSize', '25');
  const listQuery = listParams.toString();
  const backParams = new URLSearchParams(query); backParams.delete('paper');
  const backHref = `${HOME_URL}${backParams.size ? `?${backParams}` : ''}`;
  const setValue = (key: string, value: string) => navigate(next => { value ? next.set(key, value) : next.delete(key); });
  const toggle = (key: string, value: string) => navigate(next => { const values = next.getAll(key); next.delete(key); (values.includes(value) ? values.filter(item => item !== value) : [...values, value]).forEach(item => next.append(key, item)); });
  const reset = () => { navigate(next => [...next.keys()].forEach(key => next.delete(key))); setFiltersOpen(false); };
  useEffect(() => {
    const controller = new AbortController();
    const load = () => loadStatus(controller.signal).then(next => { if (controller.signal.aborted) return; const changed = statusVersion.current !== undefined && statusVersion.current !== next.generatedAt; statusVersion.current = next.generatedAt; setStatus(next); setStatusError(next.snapshotError || ''); if (changed) setRefreshKey(key => key + 1); }).catch(reason => { if (!controller.signal.aborted) setStatusError(reason.message); });
    void load(); const interval = setInterval(() => { void load(); }, 60000);
    return () => { controller.abort(); clearInterval(interval); };
  }, [refreshKey]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError('');
    loadPapers(listQuery, controller.signal).then(next => { if (!controller.signal.aborted) setResults(next); }).catch(reason => { if (!controller.signal.aborted) setError(reason.message); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [listQuery, refreshKey]);
  const journals = status?.journals || [];
  const activeFilters: Array<{ key: string; value: string; label: string }> = [];
  for (const [key, value] of params.entries()) {
    if (!value || ['page', 'pageSize', 'paper', 'sort'].includes(key) || (['pdf', 'abstract'].includes(key) && value === 'any')) continue;
    const label = key === 'journal' ? journals.find(item => item.id === value)?.shortName || value : key === 'topic' ? TOPICS.find(item => item.id === value)?.short || value : key === 'from' ? `From ${value}` : key === 'to' ? `Until ${value}` : key === 'abstract' ? 'Abstract available' : key === 'pdf' ? PUBLIC_MODE ? value === 'downloaded' ? 'OA link available' : 'No verified OA link' : value === 'downloaded' ? 'PDF downloaded' : 'PDF not downloaded' : `${key === 'name' ? 'Name' : 'Keyword'}: ${value}`;
    activeFilters.push({ key, value, label });
  }
  const lastSuccessful = status?.sources.map(source => source.lastSuccessAt).filter((value): value is string => Boolean(value)).sort().at(-1);
  const issues = status?.sources.filter(source => ['partial', 'failed'].includes(source.status)).length || 0;
  const coverageYear = status?.coverageStart.slice(0, 4);
  const last30Active = params.get('from') === last30Days() && params.get('to') === chinaToday();
  return <><a className="skip-link" href="#main-content">Skip to content</a><header className="site-header"><div className="header-inner"><a className="brand" href={HOME_URL} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); reset(); } }} aria-label="Paper Monitor library"><span className="brand-mark"><Icon name="book" size={22} /></span><span>paper<span className="brand-light">monitor</span><span className="brand-dot">.</span></span></a><nav aria-label="Main navigation"><a className={!selectedPaper ? 'nav-link selected' : 'nav-link'} href={backHref} onClick={event => { if (!event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey) { event.preventDefault(); navigate(next => next.delete('paper'), false); } }}>Research library</a><a className="nav-link" href={DIGEST_URL} target="_blank" rel="noreferrer">{PUBLIC_MODE ? 'Library overview' : 'Latest digest'} <Icon name="external" size={13} /></a></nav><span className="local-badge"><span className="status-dot ok" /> {PUBLIC_MODE ? 'Public research library' : 'Personal library'}</span></div></header>
  {selectedPaper ? <PaperDetail id={selectedPaper} journals={journals} backHref={backHref} onBack={() => navigate(next => next.delete('paper'), false)} /> : <main className="library-layout" id="main-content"><section className="library-hero"><div><div className="eyebrow"><span /> Learning analytics & artificial intelligence</div><h1>The research library<span>.</span></h1><p>{PUBLIC_MODE ? 'A public collection of new perspectives and foundational ideas.' : 'Fresh perspectives. Foundational ideas. Your field, in one place.'}</p></div><div className="hero-stats"><div><strong>{status ? status.paperCount.toLocaleString() : '—'}</strong><span>{PUBLIC_MODE ? 'Published paper records' : 'Papers in your library'}</span></div><div><strong>{journals.length || '—'}</strong><span>{PUBLIC_MODE ? 'Journals represented' : 'Journals followed'}</span></div><div><strong>{coverageYear || '—'}{coverageYear && <span className="stat-onward">+</span>}</strong><span>Historical coverage</span></div></div></section>
  {status?.contentCounts && <p className="provenance-caption content-counts" aria-label="Library content availability">{status.contentCounts.summaries.toLocaleString()} generated summaries (not author abstracts) · {PUBLIC_MODE ? <>{status.contentCounts.oaLinks?.toLocaleString() || 0} papers with OA links</> : <>{status.contentCounts.pdfs.toLocaleString()} PDFs saved · {status.contentCounts.pdfQueued.toLocaleString()} PDFs queued</>}</p>}
  {status && <CoverageOverview status={status} />}
  {PUBLIC_MODE && <div className="public-content-note"><Icon name="book" size={19} /><div><strong>Public research library</strong><p>A read-only snapshot. Abstracts are reproduced only where licensed; other abstracts link to the publisher. Collection and PDF downloads remain in the local monitor.</p></div></div>}
  <div className="collection-bar"><div><span className={`status-dot ${statusError ? 'failed' : PUBLIC_MODE ? status ? 'ok' : 'never' : issues ? 'partial' : lastSuccessful ? 'ok' : 'never'}`} /><span>{statusError ? 'Connection interrupted' : PUBLIC_MODE ? status ? `Last published ${formatTimestamp(status.generatedAt)} CST` : 'Loading published snapshot' : lastSuccessful ? `Last successful discovery ${formatTimestamp(lastSuccessful)} CST` : 'Awaiting first collection'}</span>{!PUBLIC_MODE && issues > 0 && <span className="collection-warning">{issues} {issues === 1 ? 'journal has' : 'journals have'} discovery notices</span>}</div><button onClick={() => setSourcesOpen(open => !open)} aria-expanded={sourcesOpen} aria-controls="source-health">{PUBLIC_MODE ? 'Snapshot coverage' : 'Journal & abstract status'} <Icon name="chevron" size={13} className={sourcesOpen ? 'rotate-down' : ''} /></button></div>
  {sourcesOpen && <section className="source-health" id="source-health" aria-label={PUBLIC_MODE ? 'Published coverage' : 'Collection status'}><div className="source-health-heading"><div><h2>Journal coverage</h2><p>{status ? `Historical collection from ${status.coverageStart}.` : 'Loading coverage dates.'} {PUBLIC_MODE ? 'This published snapshot does not trigger a new collection.' : 'Article discovery and abstract retrieval are separate checks; success in one does not imply success in the other.'}</p></div><button className="secondary-button small-button" onClick={() => setRefreshKey(key => key + 1)}><Icon name="refresh" size={15} /> {PUBLIC_MODE ? 'Reload snapshot' : 'Refresh status'}</button></div>{statusError && <p className="connection-error" role="alert">{statusError}</p>}<div className="source-grid">{journals.map(journal => PUBLIC_MODE ? <PublicJournalCoverage key={journal.id} journal={journal} coverage={status?.publicAbstractCoverageByJournal?.find(item => item.journalId === journal.id)} /> : <SourceStatus key={journal.id} journal={journal} source={status?.sources.find(source => source.journalId === journal.id)} coverage={status?.abstractCoverageByJournal?.find(item => item.journalId === journal.id)} />)}</div></section>}
  <div className="library-columns"><aside className={`filter-sidebar ${filtersOpen ? 'mobile-open' : ''}`} aria-label="Filter papers"><div className="filter-heading"><h2><Icon name="filter" size={16} /> Refine your reading</h2><button className="text-button" onClick={reset} disabled={!activeFilters.length}>Reset</button><button className="icon-button mobile-close" aria-label="Close filters" onClick={() => setFiltersOpen(false)}><Icon name="close" /></button></div>
  <fieldset className="filter-group"><legend>Journals <span>{journals.length || 7}</span></legend>{journals.length ? journals.map(journal => <label className="checkbox-label" key={journal.id}><input type="checkbox" checked={params.getAll('journal').includes(journal.id)} onChange={() => toggle('journal', journal.id)} /><span>{journal.name}</span></label>) : <p className="filter-hint">Loading journals…</p>}</fieldset>
  <fieldset className="filter-group"><legend>Research focus</legend>{TOPICS.map(topic => <label className="checkbox-label" key={topic.id}><input type="checkbox" checked={params.getAll('topic').includes(topic.id)} onChange={() => toggle('topic', topic.id)} /><span>{topic.label}</span></label>)}</fieldset>
  <fieldset className="filter-group date-filter"><legend>Publication date</legend><label htmlFor="date-from">From<input id="date-from" type="date" value={params.get('from') || ''} onInput={event => setValue('from', event.currentTarget.value)} onChange={event => setValue('from', event.target.value)} /></label><label htmlFor="date-to">To<input id="date-to" type="date" value={params.get('to') || ''} onInput={event => setValue('to', event.currentTarget.value)} onChange={event => setValue('to', event.target.value)} /></label><p className="filter-hint">First online date, or issue date when unavailable.</p></fieldset>
  <fieldset className="filter-group"><legend>{PUBLIC_MODE ? 'Open access' : 'Full text'}</legend><label htmlFor="pdf-filter" className="sr-only">{PUBLIC_MODE ? 'Open-access link availability' : 'PDF availability'}</label><select id="pdf-filter" value={params.get('pdf') || 'any'} onChange={event => setValue('pdf', event.target.value === 'any' ? '' : event.target.value)}><option value="any">Any availability</option><option value="downloaded">{PUBLIC_MODE ? 'OA link available' : 'PDF downloaded'}</option><option value="unavailable">{PUBLIC_MODE ? 'No verified OA link' : 'PDF not downloaded'}</option></select>{PUBLIC_MODE && <p className="filter-hint">Verified open-access locations, not locally saved files.</p>}</fieldset><div className="sidebar-note"><Icon name={PUBLIC_MODE ? 'book' : 'clock'} size={19} /><div><strong>{PUBLIC_MODE ? 'Browse the published archive' : 'A steady research rhythm'}</strong><p>{PUBLIC_MODE ? 'Search runs in your browser. Journal collection stays local.' : <>Scheduled for Monday & Thursday,<br />09:00 Asia/Shanghai.</>}</p></div></div><button className="primary-button mobile-done" onClick={() => setFiltersOpen(false)}>Show results <Icon name="arrow" size={17} /></button></aside>
  <section className="results-panel" aria-label="Research papers"><div className="search-panel"><SearchField id="name-search" label="Title or author" placeholder="Find a paper or researcher…" value={params.get('name') || ''} onApply={value => setValue('name', value)} /><SearchField id="keyword-search" label="Keywords" placeholder="e.g. feedback generative AI" value={params.get('keywords') || ''} onApply={value => setValue('keywords', value)} /><p className="search-hint">Search across titles, {PUBLIC_MODE ? 'published abstracts' : 'abstracts'}, article keywords and generated summaries. Every keyword must match.{PUBLIC_MODE && ' Withheld abstracts are not searchable.'}</p>
  <div className="abstract-filter-row"><label htmlFor="abstract-filter">Abstract availability</label><select id="abstract-filter" aria-describedby="abstract-filter-hint" value={params.get('abstract') || 'any'} onChange={event => setValue('abstract', event.target.value === 'any' ? '' : event.target.value)}><option value="any">All papers</option><option value="available">Abstract available</option></select><p id="abstract-filter-hint">{PUBLIC_MODE ? 'Only author abstracts readable on this website. Withheld abstracts and generated summaries are excluded.' : 'Only papers with an author abstract in the local library. Generated summaries are excluded.'}</p></div></div>
  <div className="results-toolbar"><div className="period-tabs" aria-label="Publication period"><button className={!params.get('from') && !params.get('to') ? 'active' : ''} onClick={() => navigate(next => { next.delete('from'); next.delete('to'); })}>All papers</button><button className={last30Active ? 'active' : ''} onClick={() => navigate(next => { next.set('from', last30Days()); next.set('to', chinaToday()); })}>Last 30 days</button></div><div className="results-toolbar-right"><button className="mobile-filter-button" onClick={() => setFiltersOpen(true)}><Icon name="filter" size={17} /> Filters{activeFilters.length ? ` (${activeFilters.length})` : ''}</button><label htmlFor="sort" className="sr-only">Sort papers</label><select id="sort" value={params.get('sort') || 'newest'} onChange={event => setValue('sort', event.target.value)}><option value="newest">Newest first</option><option value="oldest">Oldest first</option></select></div></div>
  {activeFilters.length > 0 && <div className="active-filters" aria-label="Active filters">{activeFilters.map(filter => <button key={`${filter.key}-${filter.value}`} onClick={() => navigate(next => { if (['journal', 'topic'].includes(filter.key)) { const remaining = next.getAll(filter.key).filter(value => value !== filter.value); next.delete(filter.key); remaining.forEach(value => next.append(filter.key, value)); } else next.delete(filter.key); })} aria-label={`Remove filter ${filter.label}`}>{filter.label}<Icon name="close" size={12} /></button>)}<button className="clear-all" onClick={reset}>Clear all</button></div>}
  <div className="result-count" role="status" aria-live="polite">{loading ? 'Finding papers…' : error ? 'Library temporarily unavailable' : <><strong>{results?.total.toLocaleString() || 0}</strong> {results?.total === 1 ? 'paper' : 'papers'}{activeFilters.length ? ' matching your filters' : ' to explore'}</>}<span>Collected with curiosity. Organized for you.</span></div>
  {error ? <div className="empty-state" role="alert"><span className="empty-icon"><Icon name="info" size={31} /></span><h2>We couldn’t load the library</h2><p>{error}</p><button className="primary-button" onClick={() => setRefreshKey(key => key + 1)}><Icon name="refresh" size={16} /> Try again</button></div> : loading ? <div className="loading-cards" aria-label="Loading papers">{[1, 2, 3].map(item => <div className="paper-card skeleton-card" key={item}><div className="skeleton-line small" /><div className="skeleton-line" /><div className="skeleton-line medium" /><div className="skeleton-line" /><div className="skeleton-line medium" /></div>)}</div> : results?.papers.length ? <div className="paper-list">{results.papers.map(paper => <PaperCard key={paper.id} paper={paper} journal={journals.find(journal => journal.id === paper.journalId)} onOpen={() => navigate(next => next.set('paper', paper.id), false)} />)}</div> : <div className="empty-state"><span className="empty-icon"><Icon name={activeFilters.length ? 'search' : 'book'} size={31} /></span><div className="eyebrow">{activeFilters.length ? 'A little too specific?' : 'Room for your next discovery'}</div><h2>{activeFilters.length ? 'No papers match these filters.' : PUBLIC_MODE ? 'No papers published yet.' : 'Your library starts here.'}</h2><p>{activeFilters.length ? 'Try a broader date range, fewer keywords, or another journal. Your full archive is just a click away.' : PUBLIC_MODE ? 'This snapshot has no paper records. A future publication will make the collected archive available here.' : 'The first collection will bring relevant papers from your journals into this space, with abstracts and available full texts.'}</p>{activeFilters.length ? <button className="primary-button" onClick={reset}>Explore all papers <Icon name="arrow" size={16} /></button> : <button className="secondary-button" onClick={() => setSourcesOpen(true)}>{PUBLIC_MODE ? 'View snapshot coverage' : 'View collection status'} <Icon name="arrow" size={16} /></button>}</div>}
  {!loading && !error && results && results.total > 0 && <div className="pagination"><span>Showing {Math.min((results.page - 1) * results.pageSize + 1, results.total)}–{Math.min(results.page * results.pageSize, results.total)} of {results.total.toLocaleString()}</span><div><button className="page-button" disabled={results.page <= 1} aria-label="Previous page" onClick={() => { navigate(next => next.set('page', String(results.page - 1)), false); document.querySelector('.results-panel')?.scrollIntoView({ behavior: 'smooth' }); }}><Icon name="chevron" size={15} className="rotate" /></button><span>Page <strong>{results.page}</strong> of {Math.max(1, results.totalPages)}</span><button className="page-button" disabled={results.page >= results.totalPages} aria-label="Next page" onClick={() => { navigate(next => next.set('page', String(results.page + 1)), false); document.querySelector('.results-panel')?.scrollIntoView({ behavior: 'smooth' }); }}><Icon name="chevron" size={15} /></button></div></div>}
  </section></div></main>}
  <footer className="site-footer"><span>paper<span>monitor</span>.</span><p>{PUBLIC_MODE ? 'Public snapshot · Collection and downloads remain local.' : 'A personal window into education research.'}</p><span>Learning analytics · Artificial intelligence</span></footer></>;
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
