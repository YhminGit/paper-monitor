import { isIP } from 'node:net';
import { publicAddress, redactSecrets } from './http.js';
import { effectiveDate } from './search.js';
import type { Library, Paper, RunReport } from './types.js';

/** Article metadata is plain text, never Markdown or HTML supplied by a publisher. */
function text(value: string): string {
 return redactSecrets(value).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/[\\`*_{}\[\]()#+.!|:\-]/g,'\\$&');
}
function singleLine(value: string): string { return text(value.replace(/[\r\n\t]+/g,' ')); }

/** This is a presentation check, not permission to fetch: collection performs DNS validation. */
function externalUrl(value?: string): string | undefined {
 if(!value || /[\u0000-\u0020\u007f]/.test(value) || redactSecrets(value)!==value)return undefined;
 try {
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||(url.port&&url.port!=='443'))return undefined;
  const host=url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(isIP(host)) { if(!publicAddress(host))return undefined; }
  else if(!host.includes('.')||/(^|\.)(localhost|local|internal|home|lan)$/.test(host))return undefined;
  // Keep URL punctuation from closing or extending the Markdown destination.
  return url.href.replace(/[()'<>\[\]\\]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
 }catch{return undefined;}
}
function source(value?: string): string {
 if(!value)return 'Provenance unavailable';
 const url=externalUrl(value);
 if(url)return `[Source](<${url}>)`;
 // Human-readable provider labels remain useful; invalid URLs and private paths do not.
 if(/^[\w][\w\s-]{0,100}$/.test(value))return singleLine(value);
 return 'Source link unavailable or withheld';
}
function localPdf(paper: Paper): string {
 if(paper.pdf.status!=='downloaded'||!paper.pdf.path)return '';
 const configured=Number(process.env.PAPER_MONITOR_PORT||3000);
 const port=Number.isInteger(configured)&&configured>=1&&configured<=65535?configured:3000;
 const id=encodeURIComponent(paper.id).replace(/[!'()*]/g,c=>`%${c.charCodeAt(0).toString(16).toUpperCase()}`);
 return ` · [Open in library](<http://127.0.0.1:${port}/api/papers/${id}/pdf>)`;
}
const labels:Record<string,string>={both:'Learning analytics + AI','learning-analytics':'Learning analytics','ai':'Artificial intelligence'};
export function renderReport(run: RunReport, library: Library, compact=false): string {
 const notified=new Set(run.notifications.map(x=>x.paperId));
 const papers=library.papers.filter(p=>notified.has(p.id));
 const lines=[`# Paper Monitor — ${singleLine(run.startedAt.slice(0,10))}`, '',`Run: ${singleLine(run.id)} · Archive coverage: ${singleLine(library.coverageStart)} onward`, '',`${papers.length} papers · ${run.notifications.length} publication notices · ${library.papers.length} papers in the library.`, ''];
 if(run.warnings.length) lines.push('## Collection notes','',...run.warnings.map(x=>`- ${singleLine(x)}`),'');
 for(const journal of library.journals) {
  const health=run.sources.find(x=>x.journalId===journal.id);
  lines.push(`## ${singleLine(journal.name)}`,'',`Check: ${singleLine(health?.status||'not checked')}. ${papers.filter(p=>p.journalId===journal.id).length} paper(s) in this digest.`,'');
  if(health?.errors.length)lines.push(...health.errors.map(x=>`- ${singleLine(x)}`),'');
  for(const topic of ['both','learning-analytics','ai']) {
   const group=papers.filter(p=>p.journalId===journal.id&&p.relevance.topic===topic);
   if(!group.length)continue;
   lines.push(`### ${labels[topic]}`,'');
   for(const p of group) {
    const milestones=run.notifications.filter(x=>x.paperId===p.id).map(x=>x.kind).join(', ');
    const url=externalUrl(p.url);
    lines.push(`#### ${singleLine(p.title)}`,'',`${singleLine(p.authors.join('; '))} · ${singleLine(effectiveDate(p)?.value||'Date unavailable')} · ${singleLine(milestones)}`,'',`${url?`[Publisher article](<${url}>)`:'Publisher link unavailable or withheld'}${p.doi?` · DOI: ${singleLine(p.doi)}`:''}`,'');
    if(!compact) {
     if(p.abstract)lines.push('Author abstract:', '',text(p.abstract),'',`Source: ${source(p.abstractSource)}`,'');
     else if(p.summary)lines.push('AI-generated full-text summary (not the author abstract):','',text(p.summary),'',`Full-text source: ${source(p.summarySource)}`,`Generated: ${singleLine(p.summaryGeneratedAt||'Generation date unavailable')}`,'');
     else lines.push('Abstract unavailable. Retrieval will be retried.','');
     lines.push(`Relevance: ${text(p.relevance.reason)} (${singleLine(p.relevance.method)}; ${singleLine(p.relevance.confidence)} confidence)`,'');
    }
    lines.push(`PDF: ${singleLine(p.pdf.status)}${localPdf(p)}${p.pdf.license?` · ${singleLine(p.pdf.license)}`:''}${p.pdf.version?` · ${singleLine(p.pdf.version)}`:''}`,'');
   }
  }
 }
 return lines.join('\n');
}
