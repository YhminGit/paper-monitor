# Paper Monitor

A personal research library for learning analytics and artificial intelligence. The React dashboard runs at **http://127.0.0.1:3000**, backed by local JSON snapshots and an open-access PDF archive.

Public website: **https://yhmingit.github.io/paper-monitor/**. The public edition uses a sanitized static snapshot and works independently of the collector PC. See `PUBLICATION.md` for deployment, update and content-sharing boundaries.

## Start the dashboard

Node.js 22.14 or newer is required. From this folder in PowerShell:

```powershell
npm.cmd install
npm.cmd run build
npm.cmd run web
```

Open http://127.0.0.1:3000. Keep the terminal running while you use the dashboard. On Windows, use `npm.cmd` when passing monitor options: PowerShell's `npm.ps1` can swallow argument switches. Development: `npm.cmd run dev` uses Vite on port 5173 and proxies API requests to the server on port 3000.

For a hidden background server on Windows, run `.\start-dashboard.ps1` instead of `npm.cmd run web`. It reuses an existing Paper Monitor process and writes its PID and logs under `.state`. Run it again after restarting the PC. It does not install a Windows startup task or expose the server to the network.

Search by title or author, all entered keywords, inclusive publication dates, journals, topic groups, and saved PDF availability. Filters are stored in the URL. Publication dates prefer first-online dates; partial dates retain their actual precision. A paper is listed once, with its publication events in its detail page.

## Collection workflow

Seven journals are configured in `src/config.ts`: BJET, BERJ, Computers & Education, Journal of Learning Analytics, Review of Educational Research, Educational Research Review, and Computers and Education: Artificial Intelligence. Historical collection begins January 1, 2025.

```powershell
npm.cmd run monitor -- collect
npm.cmd run monitor -- finalize RUN_ID
npm.cmd run monitor -- status
```

`collect` retrieves official RSS/OAI and Crossref records and writes a dated staging run and review request under `output/runs`. It does not change the visible library. It enriches up to 100 records and attempts up to 10 OA PDFs per invocation by default. Those are resumable batch sizes, not archive caps; relevant papers take priority, then never-attempted items before retries. Configure larger batches with `--enrich-limit=500 --download-limit=100`, or use zero for a metadata-only discovery pass. The full discovery is paginated without a record cap. `--journal=bjet` targets one journal, `--publisher=elsevier` targets its three journals, and `--refresh` reruns historical discovery. `--limit=5` is diagnostic only and never establishes complete coverage.

For an abstract catch-up use `--relevant-only --retry-missing --enrich-limit=1000 --download-limit=0`. Add `--enrich-only` to skip discovery and preserve source-check timestamps, or `--refresh` to renew historical licence metadata. Completed enrichment results are saved privately after each paper and resumed after interruption when they match the current archive generation. The normal seven-day missing-metadata retry interval remains in place unless explicitly overridden.

Missing ScienceDirect DOIs are recovered through Crossref's exact publisher-identifier filter, with matching journal ISSN, PII and full title required. A paper already announced in an official current feed can carry a future issue date: it remains visible with that actual date and precision, without inventing a first-online date. Highlights-only metadata is not presented as a complete author abstract.

Codex reviews the generated `RUN_ID.review.json`, supplies relevance decisions in `RUN_ID.decisions.json`, and then calls `finalize`. Decisions use this shape:

```json
{
  "schemaVersion": 1,
  "runId": "RUN_ID",
  "decisions": [{
    "paperId": "doi:10.example/article",
    "topic": "both",
    "reason": "The study uses AI to interpret learner activity and provide feedback.",
    "evidence": ["Specific evidence from this paper"],
    "confidence": "high"
  }]
}
```

Topics are `both`, `learning-analytics`, `ai`, `unrelated`, or `pending`. A record without enough evidence stays pending. Dictionary matches are provisional until reviewed and visibly identified as such. A missing author abstract is never invented. A decision may include a 150–250-word `summary` only when a verified downloaded PDF and extracted text exist; it is displayed separately as generated text.

`finalize` validates decisions, creates notices, writes Markdown/JSON reports, and atomically publishes the library. A repeat finalize is idempotent. First imports produce one entry per article; future issue assignment can produce a second notice. Interrupted final publication is recovered on the next collection/finalization. A crashed process can leave `.state/monitor.lock`; `npm.cmd run monitor -- unlock` removes it only after confirming its PID is no longer running.

## Public sources and optional keys

The app works with public sources. For better metadata coverage, copy `.env.example` to `.env` and set the optional `ELSEVIER_API_KEY`, `OPENALEX_API_KEY`, and `CONTACT_EMAIL` locally. Obtain keys through the official [Elsevier developer portal](https://dev.elsevier.com/) and [OpenAlex](https://openalex.org/). Keys remain server-side and are ignored by Git. Never put them in `VITE_` variables.

ScienceDirect feeds do not contain author abstracts. For those journals, the collector uses Crossref, public OpenAlex DOI batches, and the optional Elsevier API; it does not scrape ScienceDirect article HTML. [Elsevier directs automated access to supported APIs](https://www.elsevier.support/sciencedirect/answer/why-am-i-getting-a-captcha-challenge). Other publisher adapters can read explicit author-abstract sections and metadata. Publisher blocks are cached during a run and are not bypassed. OpenAlex results must match the requested DOI exactly; a failed batch does not trigger a flood of singleton retries. Unavailable abstracts and retrieval errors are recorded for later retry, and newly obtained evidence queues a fresh semantic review. The dashboard separates journal discovery health from abstract availability and the last recorded abstract check. Sage feeds may return HTTP 403 while Crossref remains usable. Per-source failures are reported and never described as zero new papers. Wiley issue-cover records without titles are skipped without aborting the journal import. JLA OAI galley relations supply direct download routes.

OA copies require a positive open-access location; ordinary publisher PDF/TDM links are not treated as permission. Downloads prefer the publisher version, then repositories. The downloader validates HTTPS, file type, PDF structure and checksum, supports HTTP ranges, and limits an individual file to 100 MB. Blocked transfers remain queued with their error and source link. Total archive size is not capped.

Multiple review parts can be validated and combined with `npm.cmd run monitor -- merge-reviews RUN_ID RUN_ID.decisions.part1.json RUN_ID.decisions.part2.json`. Files stay in `output/runs`. Generated summaries require 150–250 words, a matching registered PDF checksum and nonempty extracted full text; they are never labeled author abstracts.

## Scheduling and storage

The Codex heartbeat **Paper Monitor — journal updates** was activated after the verified manual import on September 6, 2026. It returns to this task every Monday and Thursday at 09:00 Asia/Shanghai and follows `MONITORING.md`. The computer and Codex app must remain running. Closing the browser has no effect on collection. Actual enabled status is managed in Codex Scheduled tasks; the dashboard's cadence text is not a live scheduler-status indicator.

- `output/library.json`: current library, read by the web server.
- `output/reports`: complete dated reports, compact digests, and `latest.md`.
- `output/runs`: collection, review, decision, checkpoint, and finalized JSON records.
- `output/pdf`: registered PDFs and locally extracted text.
- `.state`: complete catalog, source cursors, discovery cache, and writer lock.

Runtime outputs are ignored by Git and remain in this OneDrive project folder. Do not run independent monitor writers on multiple PCs against the same synchronized folder. The browser reads the last valid snapshot if a replacement is temporarily unavailable.

## Verification

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run build
```

Tests exercise source normalization/pagination, article identity, publication milestones, search, partial dates, live snapshot recovery, HTTP security, and registered PDF access. Browser QA covers the actual UI with live source records.

See `VERIFICATION.md` for the verified initial collection counts, test results, and remaining public-source limitations.
