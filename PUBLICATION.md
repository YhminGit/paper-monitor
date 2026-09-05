# Public research library

Public website: https://yhmingit.github.io/paper-monitor/

Repository: https://github.com/YhminGit/paper-monitor

The public edition is a static GitHub Pages website. It retains browser-side search, filters, pagination and bookmarked article details. It does not connect to the local dashboard, expose a server, run the collector in a visitor's browser, or require the collector PC to remain online for viewing.

## Content boundaries

The exporter reads the finalized local library and explicitly selects shareable fields. The public snapshot includes bibliographic metadata, topic labels, publication dates, source links and generalized collection-health information. It excludes credentials, credential-status flags, private paths, raw source errors, local PDF registrations, extracted full text, review evidence excerpts, internal identifiers and private state.

Public abstracts require a supported redistribution licence tied to the actual content source; free access alone is not permission to republish. Ambiguous abstracts are withheld with a publisher link, even when they are available in the personal dashboard. Generated summaries remain explicitly labeled and require verified source material. Third-party content retains its original rights and attribution. See [Crossref's licensing guidance](https://www.crossref.org/documentation/retrieve-metadata/).

PDFs are **not uploaded**. Visitors use lawful publisher/repository links. The public OA-link filter is different from the personal dashboard's downloaded-PDF filter. Public keyword search covers only the text actually published in the public snapshot; withheld abstracts are not shipped as hidden searchable data.

## Local export and preview

After a successful local monitor finalization:

```powershell
npm.cmd run export:public
npm.cmd run build:public
npm.cmd run preview:public
```

Preview at http://127.0.0.1:4173/paper-monitor/ . The public build never changes `dist` or the local server on port 3000. Only `public-site/data/library.json` and `public-site/data/latest.md` are public data artifacts. Do not copy `output`, `.state`, `.env`, PDFs or local reports into `public-site`.

## Publish a data update

```powershell
npm.cmd run publish:public
```

This command regenerates the sanitized export, checks the authenticated GitHub account and public destination, and creates a commit changing **only** the two approved public data paths on the existing `master` branch. Both files are updated atomically. It does not stage or push local code edits and never force-updates a branch. Unchanged data creates no commit. A concurrent remote update fails safely and requires a fresh retry.

Authentication is managed by the GitHub CLI (`gh`); no token belongs in this repository or the browser. Publishing requires the approved account's repository access. Permission failures must be reported, not worked around by weakening controls. A public snapshot commit is not proof of deployment: inspect the `Publish research library` Actions run and then the live website.

GitHub Pages deploys only `dist-public` from `.github/workflows/pages.yml`. The build has read-only repository permissions, and the deployment job has Pages/OIDC permissions. The workflow uses pinned official actions, Node 22, automated tests, and the public build. Pages must use GitHub Actions as its publishing source. The site base `/paper-monitor/` matches this repository name.

The scheduled collector remains on the user's PC. After finalizing each Monday/Thursday check, it publishes the public data and verifies deployment. If collection or publishing fails, the previous public site remains available and the digest reports the failure. Closing a browser does not stop collection. Collection still requires the PC and Codex app to be running.

## Future code changes

Snapshot publishing creates remote commits without changing the local Git index or checkout. Before publishing later **code** changes, fetch and review the remote branch, then integrate its data commits normally. Do not force-push. Keep all publication paths explicit and inspect staged content before committing; never use a blanket add of the local runtime directories.

Public source availability does not grant a blanket redistribution licence for third-party papers. No third-party PDFs or full-text rights are claimed by this project.
