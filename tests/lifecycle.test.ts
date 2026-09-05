import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test, { type TestContext } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { Journal, Library, Paper, ReviewRequest, RunReport, SourceHealth } from '../src/types.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(projectRoot, 'src', 'cli.ts');
const coverageStart = '2025-01-01';
const oldId = '2025-06-01T09-00-00-000Z-a0a0a0';
const newId = '2025-06-02T09-00-00-000Z-b0b0b0';
const journal: Journal = { id: 'bjet', name: 'British Journal of Educational Technology', shortName: 'BJET', publisher: 'wiley', issn: '1467-8535', url: 'https://bera-journals.onlinelibrary.wiley.com/journal/14678535', feeds: ['https://bera-journals.onlinelibrary.wiley.com/feed/14678535/most-recent'] };
const previousSuccess = '2025-05-31T09:00:00.000Z';

interface Catalog { papers: Paper[]; cursors: Record<string, string>; enriched: Record<string, string>; backfilled: string[]; lastRunId?: string; }
function paper(id = 'doi:10.1111/bjet.lifecycle'): Paper {
  return {
    id, doi: id.replace(/^doi:/, ''), aliases: [id], journalId: 'bjet', title: 'Learning analytics and AI for formative feedback', authors: ['A. Researcher'],
    url: 'https://example.org/research/lifecycle', keywords: ['learning analytics', 'artificial intelligence'], articleType: 'journal-article',
    abstract: 'An offline fixture concerning artificial intelligence and learning analytics.', abstractSource: 'https://example.org/research/lifecycle',
    publishedOnline: { value: '2025-02-01', precision: 'day', source: 'fixture' }, publicationDate: { value: '2025-02-01', precision: 'day', source: 'fixture' },
    firstSeenAt: previousSuccess, updatedAt: previousSuccess,
    relevance: { topic: 'both', method: 'rules', confidence: 'low', reason: 'Awaiting semantic review.', evidence: ['learning analytics', 'AI'] },
    oaLocations: [], pdf: { status: 'unavailable' }, milestones: [], provenance: [{ source: 'fixture', url: 'https://example.org/research/lifecycle', fetchedAt: previousSuccess }],
  };
}
function reviewedPaper(): Paper {
  const result = paper();
  result.relevance = { topic: 'both', method: 'codex', confidence: 'high', reason: 'Verified offline semantic-review fixture.', evidence: ['learning analytics', 'artificial intelligence'], reviewedAt: previousSuccess };
  result.milestones = [{ kind: 'backfill', observedAt: previousSuccess, date: '2025-02-01', runId: oldId }];
  return result;
}
function source(): SourceHealth { return { journalId: 'bjet', status: 'ok', checkedAt: previousSuccess, lastSuccessAt: previousSuccess, discovered: 1, errors: [] }; }
function catalog(papers: Paper[] = [], lastRunId?: string): Catalog {
  return { papers, cursors: lastRunId ? { bjet: previousSuccess } : {}, enriched: {}, backfilled: lastRunId ? ['bjet'] : [], ...(lastRunId ? { lastRunId } : {}) };
}
function library(papers: Paper[], lastRunId?: string): Library {
  return { schemaVersion: 1, generatedAt: previousSuccess, coverageStart, journals: [journal], papers, sources: [source()], ...(lastRunId ? { lastRunId } : {}) };
}
function run(id: string, papers: Paper[] = [paper()]): RunReport {
  return { schemaVersion: 1, id, startedAt: id === oldId ? '2025-06-01T09:00:00.000Z' : '2025-06-02T09:00:00.000Z', status: 'collected', coverageStart, backfill: true, papers, sources: [source()], notifications: [], warnings: [] };
}
function decision(paperId: string) { return { paperId, topic: 'both', reason: 'The paper substantively studies AI-supported learning analytics.', evidence: ['artificial intelligence', 'learning analytics'], confidence: 'high' }; }
async function json<T = unknown>(file: string): Promise<T> { return JSON.parse(await readFile(file, 'utf8')) as T; }
async function put(file: string, value: unknown) { await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8'); }
async function absent(file: string) { await assert.rejects(access(file), { code: 'ENOENT' }); }

async function environment(t: TestContext) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'paper-lifecycle-'));
  t.after(async () => { assert.ok(path.basename(root).startsWith('paper-lifecycle-')); await rm(root, { recursive: true, force: true }); });
  const preloader = path.join(root, 'offline-guard.mjs');
  // DNS fails before fetchRemote reaches its pacing/retry loop. Fetch is also guarded so
  // an accidental alternative retrieval route cannot make these tests use the internet.
  await writeFile(preloader, `import dns from 'node:dns/promises';\nimport { syncBuiltinESMExports } from 'node:module';\ndns.lookup = async () => { throw new Error('OFFLINE_FIXTURE_DISCOVERY_FAILURE'); };\nsyncBuiltinESMExports();\nglobalThis.fetch = async () => { throw new Error('OFFLINE_FIXTURE_FETCH_FORBIDDEN'); };\n`, 'utf8');
  const invoke = (args: string[]) => new Promise<{ code: number | null; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', 'tsx', '--import', pathToFileURL(preloader).href, cli, ...args], {
      cwd: projectRoot,
      env: { ...process.env, PAPER_MONITOR_ROOT: root, DOTENV_CONFIG_PATH: path.join(root, 'no-credentials.env'), ELSEVIER_API_KEY: '', OPENALEX_API_KEY: '', CONTACT_EMAIL: '' },
      stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let output = '';
    child.stdout.on('data', chunk => { output += String(chunk); });
    child.stderr.on('data', chunk => { output += String(chunk); });
    const timeout = setTimeout(() => { child.kill(); reject(new Error(`Offline lifecycle command timed out: ${args.join(' ')}\n${output}`)); }, 20_000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('close', code => { clearTimeout(timeout); resolve({ code, output }); });
  });
  return { root, invoke, file: (...parts: string[]) => path.join(root, ...parts) };
}
async function stageRun(root: string, candidate: RunReport, baseRunId?: string) {
  await put(path.join(root, 'output', 'runs', `${candidate.id}.json`), candidate);
  await put(path.join(root, 'output', 'runs', `${candidate.id}.checkpoint.json`), { complete: ['bjet'], enriched: {}, backfilled: baseRunId ? ['bjet'] : [], ...(baseRunId ? { baseRunId } : {}) });
  await put(path.join(root, 'output', 'runs', `${candidate.id}.decisions.json`), { schemaVersion: 1, runId: candidate.id, decisions: candidate.papers.map(p => decision(p.id)) });
}

test('offline cached collect publishes only on finalize and finalized reruns are byte-for-byte idempotent', { timeout: 40_000 }, async t => {
  const env = await environment(t);
  const today = new Date().toISOString().slice(0, 10);
  await put(env.file('.state', 'discovery-cache', 'bjet.json'), { key: JSON.stringify({ since: coverageStart, today }), result: { papers: [paper()], errors: [], complete: true } });
  const collected = await env.invoke(['collect', '--journal', 'bjet', '--enrich-limit', '0', '--download-limit', '0']);
  assert.equal(collected.code, 0, collected.output);
  assert.doesNotMatch(collected.output, /OFFLINE_FIXTURE/);
  const id = collected.output.match(/Collected run (\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{6})/)?.[1];
  assert.ok(id, collected.output);
  await absent(env.file('output', 'library.json'));
  const staged = await json<RunReport>(env.file('output', 'runs', `${id}.json`));
  assert.equal(staged.status, 'collected');
  assert.equal(staged.papers.length, 1);
  await put(env.file('output', 'runs', `${id}.decisions.json`), { schemaVersion: 1, runId: id, decisions: [decision(staged.papers[0].id)] });
  const finalized = await env.invoke(['finalize', id, '--download-limit', '0']);
  assert.equal(finalized.code, 0, finalized.output);
  const published = await json<Library>(env.file('output', 'library.json'));
  const committed = await json<RunReport>(env.file('output', 'runs', `${id}.json`));
  assert.equal(published.papers.length, 1);
  assert.equal(published.papers[0].relevance.method, 'codex');
  assert.equal(committed.notifications.length, 1);
  assert.equal(committed.notifications[0].kind, 'backfill');
  assert.equal(published.papers[0].milestones.length, 1);
  const state = await json<Catalog>(env.file('.state', 'catalog.json'));
  assert.equal(state.cursors.bjet, staged.startedAt);
  assert.ok(state.backfilled.includes('bjet'));
  const artifacts = [env.file('output', 'library.json'), env.file('.state', 'catalog.json'), env.file('output', 'runs', `${id}.json`), env.file('output', 'reports', 'latest.md'), env.file('output', 'reports', `${id}.digest.md`)];
  const before = await Promise.all(artifacts.map(file => readFile(file, 'utf8')));
  const repeated = await env.invoke(['finalize', id, '--download-limit', '0']);
  assert.equal(repeated.code, 0, repeated.output);
  assert.match(repeated.output, /already finalized/i);
  assert.deepEqual(await Promise.all(artifacts.map(file => readFile(file, 'utf8'))), before);
  await absent(env.file('.state', 'pending-commit.json'));
  await absent(env.file('.state', 'monitor.lock'));
});

test('malformed, mismatched, duplicate and unknown decisions are rejected before published state changes', { timeout: 60_000 }, async t => {
  const candidate = paper('doi:10.1111/bjet.candidate');
  const good = decision(candidate.id);
  const cases: Array<{ name: string; contents: unknown; raw?: string; message: RegExp }> = [
    { name: 'invalid JSON', contents: null, raw: '{broken', message: /JSON|property|position/i },
    { name: 'invalid topic', contents: { schemaVersion: 1, runId: newId, decisions: [{ ...good, topic: 'unrecognized' }] }, message: /topic|Invalid option/i },
    { name: 'run ID mismatch', contents: { schemaVersion: 1, runId: oldId, decisions: [good] }, message: /run ID mismatch/i },
    { name: 'duplicate ID', contents: { schemaVersion: 1, runId: newId, decisions: [good, good] }, message: /duplicate/i },
    { name: 'unknown ID', contents: { schemaVersion: 1, runId: newId, decisions: [decision('doi:10.1111/bjet.unknown')] }, message: /Unknown/i },
  ];
  for (const fixture of cases) await t.test(fixture.name, async subtest => {
    const env = await environment(subtest);
    await put(env.file('.state', 'catalog.json'), catalog([reviewedPaper()], oldId));
    await put(env.file('output', 'library.json'), library([reviewedPaper()], oldId));
    await stageRun(env.root, run(newId, [candidate]), oldId);
    const decisionFile = env.file('output', 'runs', `${newId}.decisions.json`);
    if (fixture.raw) await writeFile(decisionFile, fixture.raw, 'utf8'); else await put(decisionFile, fixture.contents);
    const protectedFiles = [env.file('.state', 'catalog.json'), env.file('output', 'library.json'), env.file('output', 'runs', `${newId}.json`)];
    const before = await Promise.all(protectedFiles.map(file => readFile(file, 'utf8')));
    const result = await env.invoke(['finalize', newId, '--download-limit', '0']);
    assert.equal(result.code, 1, result.output);
    assert.match(result.output, fixture.message);
    assert.deepEqual(await Promise.all(protectedFiles.map(file => readFile(file, 'utf8'))), before);
    await absent(env.file('.state', 'pending-commit.json'));
    await absent(env.file('.state', 'monitor.lock'));
  });
});

test('a stale collected run cannot overwrite a newer finalized catalog, library or report', { timeout: 30_000 }, async t => {
  const env = await environment(t);
  await stageRun(env.root, run(oldId, [paper('doi:10.1111/bjet.old')]));
  await stageRun(env.root, run(newId, [paper('doi:10.1111/bjet.new')]));
  const newer = await env.invoke(['finalize', newId, '--download-limit', '0']);
  assert.equal(newer.code, 0, newer.output);
  const files = [env.file('.state', 'catalog.json'), env.file('output', 'library.json'), env.file('output', 'reports', 'latest.md')];
  const before = await Promise.all(files.map(file => readFile(file, 'utf8')));
  const stale = await env.invoke(['finalize', oldId, '--download-limit', '0']);
  assert.equal(stale.code, 1, stale.output);
  assert.match(stale.output, /newer run|newer state|stale/i);
  assert.deepEqual(await Promise.all(files.map(file => readFile(file, 'utf8'))), before);
  assert.equal((await json<RunReport>(env.file('output', 'runs', `${oldId}.json`))).status, 'collected');
  await absent(env.file('.state', 'monitor.lock'));
});

test('an interrupted pending commit restores every artifact exactly and removes its journal once', { timeout: 30_000 }, async t => {
  const env = await environment(t);
  const recoveredPaper = reviewedPaper();
  recoveredPaper.milestones[0].runId = newId;
  const recoveredRun: RunReport = { ...run(newId, [recoveredPaper]), status: 'finalized', finishedAt: '2025-06-02T09:01:00.000Z', notifications: [{ paperId: recoveredPaper.id, kind: 'backfill' }] };
  const recoveredState = catalog([recoveredPaper], newId);
  const recoveredLibrary = library([recoveredPaper], newId);
  const report = '# Recovered complete report\n\nOne paper and one notice.\n';
  const digest = '# Recovered complete digest\n\nOne notice.\n';
  await put(env.file('.state', 'catalog.json'), catalog([], oldId));
  await put(env.file('output', 'library.json'), library([], oldId));
  await stageRun(env.root, run(newId, [recoveredPaper]), oldId);
  await put(env.file('.state', 'pending-commit.json'), { state: recoveredState, library: recoveredLibrary, run: recoveredRun, report, digest });
  // Simulate interruption after one of several atomic replacements: the dated report is
  // already new, while the catalog, public library and collected run are still old.
  await mkdir(env.file('output', 'reports'), { recursive: true });
  await writeFile(env.file('output', 'reports', `${newId}.md`), report, 'utf8');
  await writeFile(env.file('output', 'reports', 'latest.md'), '# Previous report\n', 'utf8');
  const result = await env.invoke(['finalize', newId, '--download-limit', '0']);
  assert.equal(result.code, 0, result.output);
  assert.match(result.output, /already finalized/i);
  assert.deepEqual(await json(env.file('.state', 'catalog.json')), recoveredState);
  assert.deepEqual(await json(env.file('output', 'library.json')), recoveredLibrary);
  assert.deepEqual(await json(env.file('output', 'runs', `${newId}.json`)), recoveredRun);
  assert.equal(await readFile(env.file('output', 'reports', `${newId}.md`), 'utf8'), report);
  assert.equal(await readFile(env.file('output', 'reports', 'latest.md'), 'utf8'), report);
  assert.equal(await readFile(env.file('output', 'reports', `${newId}.digest.md`), 'utf8'), digest);
  await absent(env.file('.state', 'pending-commit.json'));
  const repeated = await env.invoke(['finalize', newId, '--download-limit', '0']);
  assert.equal(repeated.code, 0, repeated.output);
  assert.deepEqual(await json(env.file('output', 'runs', `${newId}.json`)), recoveredRun);
  await absent(env.file('.state', 'monitor.lock'));
});

test('discovery failure retains reviewed library papers, successful cursors and delivered milestones', { timeout: 30_000 }, async t => {
  const env = await environment(t);
  const retained = reviewedPaper();
  await put(env.file('.state', 'catalog.json'), catalog([retained], oldId));
  await put(env.file('output', 'library.json'), library([retained], oldId));
  const originalLibrary = await readFile(env.file('output', 'library.json'), 'utf8');
  const collected = await env.invoke(['collect', '--journal', 'bjet', '--refresh', '--enrich-limit', '0', '--download-limit', '0']);
  assert.equal(collected.code, 0, collected.output);
  assert.match(collected.output, /BJET: 0 records; failed/);
  assert.equal(await readFile(env.file('output', 'library.json'), 'utf8'), originalLibrary);
  const id = collected.output.match(/Collected run (\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{6})/)?.[1];
  assert.ok(id, collected.output);
  const staged = await json<RunReport>(env.file('output', 'runs', `${id}.json`));
  assert.equal(staged.papers.length, 1);
  assert.match(staged.sources.find(item => item.journalId === 'bjet')!.errors.join(' '), /OFFLINE_FIXTURE_DISCOVERY_FAILURE/);
  const finalized = await env.invoke(['finalize', id, '--download-limit', '0']);
  assert.equal(finalized.code, 0, finalized.output);
  const published = await json<Library>(env.file('output', 'library.json'));
  assert.match(published.papers[0].relevance.reviewedFingerprint!, /^[a-f0-9]{64}$/);
  const {reviewedFingerprint: _fingerprint, ...preservedRelevance}=published.papers[0].relevance;
  assert.deepEqual([{...published.papers[0],relevance:preservedRelevance}], [retained]);
  const failedSource = published.sources.find(item => item.journalId === 'bjet')!;
  assert.equal(failedSource.status, 'failed');
  assert.equal(failedSource.lastSuccessAt, previousSuccess);
  const state = await json<Catalog>(env.file('.state', 'catalog.json'));
  assert.equal(state.cursors.bjet, previousSuccess);
  assert.deepEqual(state.backfilled, ['bjet']);
  assert.equal((await json<RunReport>(env.file('output', 'runs', `${id}.json`))).notifications.length, 0);
  await absent(env.file('.state', 'monitor.lock'));
});

test('missing or scanned PDF text cannot block finalization and remains queued for abstract retrieval', { timeout: 30_000 }, async t => {
  const env=await environment(t);
  // PDF parsing was completed at download time; this path checks its registered
  // checksum and sidecar text without re-running the downloader or using a network.
  const bytes=Buffer.from('%PDF-1.7\nPreviously validated download fixture\n%%EOF');
  const sha256=createHash('sha256').update(bytes).digest('hex');
  const abstract=Array.from({length:70},(_,index)=>`evidence${index}`).join(' ')+'.';
  const cases=[
    {name:'missing',text:undefined},
    {name:'scanned',text:'[Page 1]\n'},
    {name:'no-boundaries',text:'Readable paper text without explicit abstract boundaries. '.repeat(10)},
    {name:'recoverable',text:`[Page 1]\nABSTRACT ${abstract} Keywords: learning analytics`},
  ];
  const candidates:Paper[]=[];
  await mkdir(env.file('output','pdf'),{recursive:true});
  for(const fixture of cases) {
    const candidate=paper(`doi:10.1111/bjet.${fixture.name}`);
    candidate.title+=` (${fixture.name})`;candidate.url=`https://publisher.example/articles/${fixture.name}`;
    delete candidate.abstract;delete candidate.abstractSource;
    candidate.pdf={status:'downloaded',path:`pdf/${fixture.name}.pdf`,sourceUrl:`https://publisher.example/${fixture.name}.pdf`,sha256};
    await writeFile(env.file('output','pdf',`${fixture.name}.pdf`),bytes);
    if(fixture.text!==undefined)await writeFile(env.file('output','pdf',`${fixture.name}.pdf.txt`),fixture.text,'utf8');
    candidates.push(candidate);
  }
  candidates.push(paper('doi:10.1111/bjet.unaffected'));
  await stageRun(env.root,run(newId,candidates));
  const finalized=await env.invoke(['finalize',newId,'--download-limit','0']);
  assert.equal(finalized.code,0,finalized.output);
  const published=await json<Library>(env.file('output','library.json'));
  const committed=await json<RunReport>(env.file('output','runs',`${newId}.json`));
  assert.equal(committed.status,'finalized');
  assert.equal(published.papers.length,5);
  assert.equal(committed.notifications.length,5);
  assert.equal(committed.warnings.filter(warning=>warning.includes('Author abstract unavailable')).length,3);
  for(const candidate of published.papers.slice(0,3)) {
    assert.equal(candidate.abstract,undefined);
    assert.equal(candidate.summary,undefined);
    assert.equal(candidate.pdf.status,'downloaded');
    assert.ok(committed.warnings.some(warning=>warning.includes(candidate.id)&&warning.includes('Retrieval will be retried')));
  }
  assert.equal(published.papers[3].abstract,abstract);
  assert.equal(published.papers[3].abstractSource,'https://publisher.example/recoverable.pdf#page=1');
  assert.equal(published.papers[4].abstract,candidates[4].abstract);
  assert.ok(!committed.warnings.join(' ').includes(env.root),'recovery warnings must not leak local exception paths');
  assert.ok(!committed.warnings.join(' ').includes('ENOENT'));
  const report=await readFile(env.file('output','reports','latest.md'),'utf8');
  assert.match(report,/Retrieval will be retried/);
  await absent(env.file('.state','pending-commit.json'));
  await absent(env.file('.state','monitor.lock'));

  const collected=await env.invoke(['collect','--journal','bjet','--refresh','--enrich-limit','0','--download-limit','0']);
  assert.equal(collected.code,0,collected.output);
  const retryId=collected.output.match(/Collected run (\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{6})/)?.[1];
  assert.ok(retryId,collected.output);
  const retry=await json<ReviewRequest>(env.file('output','runs',`${retryId}.review.json`));
  assert.deepEqual(retry.papers.filter(item=>item.needsSummary).map(item=>item.paper.id).sort(),candidates.slice(0,3).map(candidate=>candidate.id).sort());
});

test('best-effort abstract recovery never relaxes validation of an explicit generated summary', { timeout: 30_000 }, async t => {
  for(const mode of ['missing-text','empty-text','wrong-checksum'])await t.test(mode,async subtest=>{
    const env=await environment(subtest);
    const candidate=paper(`doi:10.1111/bjet.${mode}`);
    delete candidate.abstract;delete candidate.abstractSource;
    const bytes=Buffer.from('%PDF-1.7\nRegistered summary fixture\n%%EOF');
    candidate.pdf={status:'downloaded',path:'pdf/source.pdf',sourceUrl:'https://publisher.example/source.pdf',sha256:mode==='wrong-checksum'?'wrong':createHash('sha256').update(bytes).digest('hex')};
    await mkdir(env.file('output','pdf'),{recursive:true});
    await writeFile(env.file('output','pdf','source.pdf'),bytes);
    if(mode!=='missing-text')await writeFile(env.file('output','pdf','source.pdf.txt'),mode==='empty-text'?'':'Source text for validation. '.repeat(20),'utf8');
    await put(env.file('.state','catalog.json'),catalog([reviewedPaper()],oldId));
    await put(env.file('output','library.json'),library([reviewedPaper()],oldId));
    await stageRun(env.root,run(newId,[candidate]),oldId);
    const summary=Array.from({length:160},(_,index)=>`summary${index}`).join(' ');
    await put(env.file('output','runs',`${newId}.decisions.json`),{schemaVersion:1,runId:newId,decisions:[{...decision(candidate.id),summary}]});
    const protectedFiles=[env.file('.state','catalog.json'),env.file('output','library.json'),env.file('output','runs',`${newId}.json`)];
    const before=await Promise.all(protectedFiles.map(file=>readFile(file,'utf8')));
    const finalized=await env.invoke(['finalize',newId,'--download-limit','0']);
    assert.equal(finalized.code,1,finalized.output);
    assert.match(finalized.output,mode==='missing-text'?/ENOENT|no such file/i:mode==='empty-text'?/nonempty extracted full text/:/checksum/);
    assert.deepEqual(await Promise.all(protectedFiles.map(file=>readFile(file,'utf8'))),before);
    await absent(env.file('.state','pending-commit.json'));
    await absent(env.file('.state','monitor.lock'));
  });
});
