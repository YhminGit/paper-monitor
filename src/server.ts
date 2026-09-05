import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createReadStream } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import { z } from 'zod';
import { COVERAGE_START, JOURNALS, OUTPUT, ROOT, credentialStatus } from './config.js';
import { parseSearch, searchPapers, SearchInputError, dateInterval } from './search.js';
import type { Journal, Library, Paper } from './types.js';
import { redactSecrets, safeError } from './http.js';

const paperDate = z.object({ value: z.string().refine(value => Boolean(dateInterval(value))), precision: z.enum(['day', 'month', 'year']), source: z.string() });
const librarySchema = z.object({
  schemaVersion: z.literal(1), generatedAt: z.string(), coverageStart: z.string(), lastRunId: z.string().optional(),
  journals: z.array(z.object({ id: z.string(), name: z.string(), shortName: z.string(), issn: z.string(), publisher: z.enum(['wiley', 'elsevier', 'jla', 'sage']), url: z.string(), feeds: z.array(z.string()) })),
  sources: z.array(z.object({ journalId: z.string(), status: z.enum(['ok', 'partial', 'failed', 'never']), checkedAt: z.string().optional(), lastSuccessAt: z.string().optional(), discovered: z.number(), errors: z.array(z.string()) })),
  papers: z.array(z.object({
    id: z.string().min(1), doi: z.string().optional(), pii: z.string().optional(), aliases: z.array(z.string()), journalId: z.string(), title: z.string(), authors: z.array(z.string()), url: z.string(), keywords: z.array(z.string()), articleType: z.string(),
    abstract: z.string().optional(), abstractSource: z.string().optional(), summary: z.string().optional(), summarySource: z.string().optional(), summaryGeneratedAt: z.string().optional(),
    abstractRetrieval: z.object({ checkedAt: z.string(), status: z.enum(['available', 'not-found', 'partial']), errors: z.array(z.string()) }).optional(),
    publishedOnline: paperDate.optional(), publishedIssue: paperDate.optional(), publicationDate: paperDate.optional(), volume: z.string().optional(), issue: z.string().optional(), pages: z.string().optional(), firstSeenAt: z.string(), updatedAt: z.string(),
    relevance: z.object({ topic: z.enum(['both', 'learning-analytics', 'ai', 'unrelated', 'pending']), method: z.enum(['rules', 'codex']), confidence: z.enum(['high', 'medium', 'low']), reason: z.string(), evidence: z.array(z.string()), reviewedAt: z.string().optional(), reviewedFingerprint: z.string().optional() }),
    oaLocations: z.array(z.object({ url: z.string(), pdfUrl: z.string().optional(), hostType: z.enum(['publisher', 'repository']), version: z.string().optional(), license: z.string().optional(), isOa: z.boolean(), source: z.string() })),
    pdf: z.object({ status: z.enum(['pending', 'downloaded', 'unavailable', 'blocked', 'failed']), path: z.string().optional(), sourceUrl: z.string().optional(), sha256: z.string().optional(), bytes: z.number().optional(), license: z.string().optional(), version: z.string().optional(), error: z.string().optional(), attemptedAt: z.string().optional() }),
    milestones: z.array(z.object({ kind: z.enum(['online', 'issue', 'backfill']), observedAt: z.string(), date: z.string().optional(), runId: z.string().optional() })),
    provenance: z.array(z.object({ source: z.string(), url: z.string(), fetchedAt: z.string() })),
  })).refine(papers => new Set(papers.map(paper => paper.id)).size === papers.length, 'Duplicate paper IDs'),
});

export interface PaperServerOptions { outputDir?: string; distDir?: string; journals?: Journal[]; coverageStart?: string; }

class SnapshotStore {
  private snapshot: Library;
  private fingerprint = '';
  private pending?: Promise<Library>;
  error?: string;
  constructor(private filename: string, journals: Journal[], coverageStart: string) {
    this.snapshot = { schemaVersion: 1, generatedAt: '', coverageStart, journals, papers: [], sources: journals.map(journal => ({ journalId: journal.id, status: 'never', discovered: 0, errors: [] })) };
  }
  async get(): Promise<Library> {
    if (this.pending) return this.pending;
    this.pending = this.refresh();
    try { return await this.pending; } finally { this.pending = undefined; }
  }
  private async refresh(): Promise<Library> {
    try {
      const info = await stat(this.filename, { bigint: true });
      const fingerprint = `${info.mtimeNs}:${info.ctimeNs}:${info.size}:${info.ino}`;
      if (this.fingerprint === fingerprint) return this.snapshot;
      const parsed = librarySchema.parse(JSON.parse(await readFile(this.filename, 'utf8')));
      this.snapshot = parsed;
      this.fingerprint = fingerprint;
      this.error = undefined;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === 'ENOENT';
      this.error = missing && !this.fingerprint ? undefined : 'The latest archive could not be read. Showing the last valid snapshot.';
    }
    return this.snapshot;
  }
}

function sendJson(request: IncomingMessage, response: ServerResponse, status: number, data: unknown) {
  const body = redactSecrets(JSON.stringify(data));
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Content-Length': Buffer.byteLength(body) });
  response.end(request.method === 'HEAD' ? undefined : body);
}

function publicPaper(paper: Paper): Paper {
  const { path: _privatePath, ...pdf } = paper.pdf;
  const abstractRetrieval = paper.abstractRetrieval && { ...paper.abstractRetrieval, errors: paper.abstractRetrieval.errors.slice(0, 12).map(error => safeError(error).replace(/https?:\/\/[^\s"'<>]+/gi, value => {
    try { const url = new URL(value); url.username = ''; url.password = ''; return url.href; } catch { return '[source URL unavailable]'; }
  }).replace(/\b[A-Za-z]:[\\/][^\r\n"']+/g, '[local path]').slice(0, 400)) };
  return { ...paper, pdf, abstractRetrieval };
}

/** Discovery health and abstract completeness are intentionally independent. */
function abstractCoverage(papers: readonly Paper[]) {
  const checked = papers.filter(paper => paper.abstractRetrieval);
  return {
    papers: papers.length,
    available: papers.filter(paper => Boolean(paper.abstract?.trim())).length,
    missing: papers.filter(paper => !paper.abstract?.trim()).length,
    summaries: papers.filter(paper => Boolean(paper.summary?.trim())).length,
    attempted: checked.length,
    partial: checked.filter(paper => paper.abstractRetrieval!.status === 'partial').length,
    notFound: checked.filter(paper => paper.abstractRetrieval!.status === 'not-found').length,
    noRecordedCheck: papers.length - checked.length,
    missingWithoutRecordedCheck: papers.filter(paper => !paper.abstract?.trim() && !paper.abstractRetrieval).length,
    lastCheckedAt: checked.map(paper => paper.abstractRetrieval!.checkedAt).filter(Boolean).sort().at(-1),
  };
}

function inside(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function registeredFile(root: string, candidate: string): Promise<string | undefined> {
  const absoluteRoot = path.resolve(root);
  const absoluteCandidate = path.resolve(candidate);
  if (!inside(absoluteRoot, absoluteCandidate)) return undefined;
  try {
    const [resolvedRoot, resolvedFile] = await Promise.all([realpath(absoluteRoot), realpath(absoluteCandidate)]);
    if (!inside(resolvedRoot, resolvedFile) || !(await stat(resolvedFile)).isFile()) return undefined;
    return resolvedFile;
  } catch { return undefined; }
}

const mimeTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.json': 'application/json', '.pdf': 'application/pdf', '.md': 'text/markdown; charset=utf-8' };

async function sendFile(request: IncomingMessage, response: ServerResponse, filename: string, options: { pdf?: boolean; download?: boolean; name?: string } = {}) {
  const info = await stat(filename);
  const headers: http.OutgoingHttpHeaders = { 'Content-Type': options.pdf ? 'application/pdf' : (mimeTypes[path.extname(filename)] || 'application/octet-stream'), 'Content-Length': info.size, 'Cache-Control': 'no-cache' };
  let start = 0;
  let end = info.size - 1;
  let status = 200;
  if (options.pdf) {
    headers['Accept-Ranges'] = 'bytes';
    const name = `${options.name || 'paper'}.pdf`.replace(/[\r\n"\\]/g, '_');
    headers['Content-Disposition'] = `${options.download ? 'attachment' : 'inline'}; filename="paper.pdf"; filename*=UTF-8''${encodeURIComponent(name)}`;
    if (request.headers.range) {
      const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range);
      if (!range || (!range[1] && !range[2])) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
      if (!range[1]) { const suffix = Number(range[2]); start = Math.max(0, info.size - suffix); }
      else { start = Number(range[1]); if (range[2]) end = Math.min(Number(range[2]), end); }
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start > end || start >= info.size) { response.writeHead(416, { 'Content-Range': `bytes */${info.size}` }); response.end(); return; }
      status = 206;
      headers['Content-Range'] = `bytes ${start}-${end}/${info.size}`;
      headers['Content-Length'] = end - start + 1;
    }
  }
  response.writeHead(status, headers);
  if (request.method === 'HEAD') { response.end(); return; }
  const stream = createReadStream(filename, info.size ? { start, end } : undefined);
  stream.on('error', () => response.destroy());
  response.on('close', () => stream.destroy());
  stream.pipe(response);
}

function requestHost(request: IncomingMessage): URL | undefined {
  try {
    const raw = request.headers.host;
    if (!raw || /[\s/@\\?#]/.test(raw)) return undefined;
    const parsed = new URL(`http://${raw}`);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return undefined;
    return parsed;
  } catch { return undefined; }
}

export function createPaperServer(options: PaperServerOptions = {}): http.Server {
  const output = path.resolve(options.outputDir || OUTPUT);
  const dist = path.resolve(options.distDir || path.join(ROOT, 'dist'));
  const store = new SnapshotStore(path.join(output, 'library.json'), options.journals || JOURNALS, options.coverageStart || COVERAGE_START);
  return http.createServer((request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('X-Frame-Options', 'DENY');
    response.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; object-src 'none'; base-uri 'self'");
    void (async () => {
      const host = requestHost(request);
      if (!host) { sendJson(request, response, 403, { error: 'Only local dashboard requests are allowed.' }); return; }
      if (request.method !== 'GET' && request.method !== 'HEAD') { response.setHeader('Allow', 'GET, HEAD'); sendJson(request, response, 405, { error: 'This server is read-only.' }); return; }
      const url = new URL(request.url || '/', host);
      if (url.origin !== host.origin) { sendJson(request, response, 403, { error: 'Invalid request origin.' }); return; }
      if (url.pathname.startsWith('/api/')) {
        if ((request.headers.origin && request.headers.origin !== host.origin) || request.headers['sec-fetch-site'] === 'cross-site') { sendJson(request, response, 403, { error: 'Cross-origin API requests are not allowed.' }); return; }
        const library = await store.get();
        if (url.pathname === '/api/papers') { const results = searchPapers(library.papers, parseSearch(url.searchParams)); sendJson(request, response, 200, { ...results, papers: results.papers.map(publicPaper) }); return; }
        if (url.pathname === '/api/status') {
          const { papers, ...metadata } = library;
          const visible = papers.filter(paper => ['both', 'learning-analytics', 'ai'].includes(paper.relevance.topic));
          const coverage = abstractCoverage(visible);
          const journalIds = [...new Set([...library.journals.map(journal => journal.id), ...visible.map(paper => paper.journalId)])];
          sendJson(request, response, 200, { application:'paper-monitor', ...metadata, paperCount: visible.length, contentCounts:{abstracts:coverage.available,summaries:coverage.summaries,pdfs:visible.filter(p=>p.pdf.status==='downloaded').length,missingAbstracts:coverage.missing,pdfQueued:visible.filter(p=>p.pdf.status!=='downloaded'&&p.oaLocations.some(l=>l.isOa&&l.pdfUrl)).length}, abstractCoverage:coverage, abstractCoverageByJournal:journalIds.map(journalId=>({journalId,...abstractCoverage(visible.filter(paper=>paper.journalId===journalId))})), credentials: credentialStatus(), snapshotError: store.error }); return;
        }
        if (url.pathname === '/api/reports/latest') {
          const filename = await registeredFile(path.join(output, 'reports'), path.join(output, 'reports', 'latest.md'));
          if (!filename) { sendJson(request, response, 404, { error: 'No report is available yet.' }); return; }
          await sendFile(request, response, filename); return;
        }
        const match = /^\/api\/papers\/([^/]+)(\/pdf)?$/.exec(url.pathname);
        if (match) {
          let id: string;
          try { id = decodeURIComponent(match[1]); } catch { sendJson(request, response, 400, { error: 'Invalid paper identifier.' }); return; }
          const paper = library.papers.find(candidate => candidate.id === id && ['both', 'learning-analytics', 'ai'].includes(candidate.relevance.topic));
          if (!paper) { sendJson(request, response, 404, { error: 'Paper not found.' }); return; }
          if (!match[2]) { sendJson(request, response, 200, publicPaper(paper)); return; }
          const filename = paper.pdf.status === 'downloaded' && paper.pdf.path ? await registeredFile(path.join(output, 'pdf'), path.isAbsolute(paper.pdf.path) ? paper.pdf.path : path.resolve(output, paper.pdf.path)) : undefined;
          if (!filename) { sendJson(request, response, 404, { error: 'This paper has no available local PDF.' }); return; }
          await sendFile(request, response, filename, { pdf: true, download: url.searchParams.get('download') === '1', name: paper.title }); return;
        }
        sendJson(request, response, 404, { error: 'API endpoint not found.' }); return;
      }
      let pathname: string;
      try { pathname = decodeURIComponent(url.pathname); } catch { sendJson(request, response, 400, { error: 'Invalid URL.' }); return; }
      if (pathname.includes('\0') || pathname.includes('\\') || pathname.split('/').some(segment => segment === '..' || segment.startsWith('.'))) { sendJson(request, response, 404, { error: 'File not found.' }); return; }
      const filename = await registeredFile(dist, path.join(dist, pathname));
      if (filename) { await sendFile(request, response, filename); return; }
      if (!path.extname(pathname)) {
        const index = await registeredFile(dist, path.join(dist, 'index.html'));
        if (index) { await sendFile(request, response, index); return; }
      }
      sendJson(request, response, 404, { error: 'Dashboard build is unavailable. Run npm run build first.' });
    })().catch(error => {
      if (response.headersSent) { response.destroy(); return; }
      sendJson(request, response, error instanceof SearchInputError ? 400 : 500, { error: error instanceof SearchInputError ? error.message : 'The dashboard could not complete this request.' });
    });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const port = Number(process.env.PAPER_MONITOR_PORT || '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PAPER_MONITOR_PORT must be between 1 and 65535.');
  const server = createPaperServer();
  server.on('error', error => { process.stderr.write(`Dashboard server failed: ${error.message}\n`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => process.stdout.write(`Paper Monitor: http://127.0.0.1:${port}\n`));
}
