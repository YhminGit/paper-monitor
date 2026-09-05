# Initial implementation verification

Verified on September 6, 2026 (Asia/Shanghai). This is a point-in-time record, not a live coverage claim.

## Running application

- Local dashboard: http://127.0.0.1:3000, started as a hidden background process using `start-dashboard.ps1`.
- Production build and TypeScript checks pass; 112 automated tests pass.
- The live network connector returned a valid Crossref response with connection-time public-address validation enabled.
- The Codex heartbeat `paper-monitor-journal-updates` is ACTIVE for Monday and Thursday at 09:00 local Asia/Shanghai time. It runs in the existing task; the PC and Codex app must stay running.

## Imported library

The historical discovery starts January 1, 2025 and has been manually collected and finalized. The latest finalized run is `2026-09-05T15-57-44-435Z-d0490d`. It published 667 distinct relevant papers, 314 author abstracts, one separately labeled generated summary, and 16 validated local PDFs.

| Journal | Relevant papers |
| --- | ---: |
| British Journal of Educational Technology | 92 |
| British Educational Research Journal | 29 |
| Computers & Education | 141 |
| Journal of Learning Analytics | 64 |
| Review of Educational Research | 5 |
| Educational Research Review | 15 |
| Computers and Education: Artificial Intelligence | 321 |

Public-source retrieval is **not yet complete**. There are 353 relevant papers without author abstracts and 76 known OA PDF records queued or needing retry. Additional full-text locations may be discovered during metadata enrichment. These counts are visible in the dashboard and retries continue in scheduled batches, without an archive-wide download limit. No API keys were required or supplied.

Official Wiley and ScienceDirect feeds and JLA OAI were exercised live, with overlapping, paginated Crossref discovery for every journal. Both Sage feeds returned HTTP 403; Crossref fallback succeeded and the failure remains visible. Wiley partial notices identify skipped untitled issue-cover metadata, not an aborted historical query. Publisher restrictions were not bypassed. Future completeness depends on source availability and metadata quality.

## Verified behaviors

- Case-insensitive title/author search, all-term keywords, AND-combined filters, OR journal/topic selections, inclusive and incomplete dates, unknown dates, stable sorting, and fixed 25-paper pagination.
- Browser reload and Back preserve bookmarked searches and page numbers. A combined author/keywords/JLA/PDF/same-day date search returns the expected single article.
- Responsive mobile filter drawer at 390-pixel width, with no horizontal overflow; desktop long-title detail page, complete abstract, source link, relevance explanation, and publication milestones.
- Explicit author-abstract and generated-summary labels, including a recovered PDF author abstract with its page-number source.
- No-results, invalid-date, missing-paper and unavailable-content states. Empty-library state was checked before import. No browser JavaScript errors were observed in the final normal-use check.
- A real JLA PDF opened and rendered in the browser. The download route returns HTTP 200 with PDF attachment headers; a byte-range request returns HTTP 206 and the actual `%PDF-` signature. The in-app browser's automated download event timed out, so OS save-dialog completion is not claimed.
- Tests cover duplicate/milestone lifecycle, atomic archive replacement and last-valid-snapshot retention, per-source failures, idempotent/recoverable finalization, abstract provenance, strict generated-summary provenance, PDF validation/resumption/checksums, scanned or missing PDF text, route traversal protection, DNS-rebinding defenses, secret redaction, and read-only endpoints.

Closing the browser does not stop collection. After a PC restart, run `.\start-dashboard.ps1` to restore the dashboard; no Windows startup task was installed. The dashboard never triggers journal collection on browsing or searching.
