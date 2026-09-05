import path from 'node:path';
import { isIP } from 'node:net';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { atomicWrite } from './storage.js';
import { publicAddress, redactSecrets } from './http.js';
import { dateInterval } from './search.js';
import { isExcluded } from './relevance.js';
import type { Journal, Library, Paper, PaperDate, SourceHealth } from './types.js';

const timestamp=z.string().refine(value=>/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(value)&&Number.isFinite(Date.parse(value)),'Invalid timestamp');
const date=z.object({value:z.string().refine(value=>Boolean(dateInterval(value))),precision:z.enum(['year','month','day']),source:z.string()}).refine(value=>value.value.length===({year:4,month:7,day:10}[value.precision]),'Date precision mismatch');
const location=z.object({url:z.string(),pdfUrl:z.string().optional(),hostType:z.enum(['publisher','repository']),version:z.string().optional(),license:z.string().optional(),isOa:z.boolean(),source:z.string()});
const articleLicense=z.object({doi:z.string(),url:z.string(),appliesTo:z.enum(['vor','am','tdm','stm-asf','unknown']),start:date.optional(),source:z.literal('crossref'),sourceUrl:z.string(),fetchedAt:timestamp});
const paperSchema=z.object({
 id:z.string().min(1),doi:z.string().optional(),pii:z.string().optional(),journalId:z.string(),title:z.string().min(1),authors:z.array(z.string()),url:z.string(),keywords:z.array(z.string()),articleType:z.string(),
 abstract:z.string().optional(),abstractSource:z.string().optional(),summary:z.string().optional(),summarySource:z.string().optional(),summaryGeneratedAt:timestamp.optional(),
 licenses:z.array(articleLicense).optional(),
 publishedOnline:date.optional(),publishedIssue:date.optional(),publicationDate:date.optional(),volume:z.string().optional(),issue:z.string().optional(),pages:z.string().optional(),firstSeenAt:timestamp,updatedAt:timestamp,
 relevance:z.object({topic:z.enum(['both','learning-analytics','ai','unrelated','pending']),method:z.enum(['rules','codex']),confidence:z.enum(['high','medium','low'])}),
 oaLocations:z.array(location),pdf:z.object({status:z.enum(['pending','downloaded','unavailable','blocked','failed']),path:z.string().optional(),sourceUrl:z.string().optional(),sha256:z.string().optional(),license:z.string().optional(),version:z.string().optional()}),
 milestones:z.array(z.object({kind:z.enum(['online','issue','backfill']),observedAt:timestamp,date:z.string().refine(value=>Boolean(dateInterval(value))).optional()})),
 provenance:z.array(z.object({source:z.string(),url:z.string(),fetchedAt:timestamp})),
});
const inputSchema=z.object({schemaVersion:z.literal(1),generatedAt:timestamp,coverageStart:z.string().refine(value=>value.length===10&&Boolean(dateInterval(value))),
 journals:z.array(z.object({id:z.string().regex(/^[a-z0-9-]{1,80}$/),name:z.string(),shortName:z.string(),issn:z.string(),publisher:z.enum(['wiley','elsevier','jla','sage']),url:z.string()})),
 papers:z.array(paperSchema),sources:z.array(z.object({journalId:z.string(),status:z.enum(['ok','partial','failed','never']),checkedAt:timestamp.optional(),lastSuccessAt:timestamp.optional(),discovered:z.number().int().nonnegative()})),
}).superRefine((library,context)=>{
 const journals=new Set(library.journals.map(journal=>journal.id));
 if(journals.size!==library.journals.length||new Set(library.papers.map(paper=>paper.id)).size!==library.papers.length)context.addIssue({code:'custom',message:'Duplicate journal or paper identifier'});
 if([...library.papers,...library.sources].some(item=>!journals.has(item.journalId)))context.addIssue({code:'custom',message:'Unknown journal reference'});
});
type InputPaper=z.infer<typeof paperSchema>;
type InputLocation=z.infer<typeof location>;

const secretMarker=/(?:api[-_]?key|access[-_]?token|authorization|credential|signature|signed|x-amz-|x-goog-|awsaccesskeyid|(?:^|[/?&#=])(?:token|secret|auth|sig|key|policy|expires|email|mailto)(?:[=/&#]|$))/i;
const privatePath=/(?:(?:^|[\s"'=(])(?:[a-z]:[\\/]|\\\\)|(?:^|[\s=])\/(?:home|users|private|tmp|var|mnt)\/|(?:^|[\s=])\.?\.?[\\/](?:\.state|output[\\/]pdf|\.env)(?:[\\/\s]|$))/i;

/** Static-link gate: no network is performed and no private/signed URL is published. */
export function safePublicUrl(value?:string):string|undefined {
 if(!value||/[\u0000-\u0020\u007f\\]/.test(value)||redactSecrets(value)!==value)return undefined;
 try {
  const decoded=decodeURIComponent(value);
  if(secretMarker.test(decoded)||privatePath.test(decoded)||/eyJ[\w-]+\.[\w-]+\.[\w-]+/.test(decoded))return undefined;
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password||(url.port&&url.port!==(url.protocol==='https:'?'443':'80'))||privatePath.test(decodeURIComponent(url.pathname)))return undefined;
  const host=url.hostname.replace(/^\[|\]$/g,'').replace(/\.$/,'');
  if(isIP(host)){if(!publicAddress(host))return undefined;}
  else if(!host.includes('.')||/(^|\.)(localhost|local|internal|home|lan|invalid|test)$/.test(host)||/(?:^|[.-])(?:127[.-]0[.-]0[.-]1|192[.-]168|10[.-]\d|169[.-]254)(?:[.-]|$)/.test(host))return undefined;
  // Unknown query parameters may be credentials; retain only established public identifiers.
  for(const [key,value] of [...url.searchParams]) {
   if(/^(?:utm_.+|dgcid|ref)$/i.test(key)){url.searchParams.delete(key);continue;}
   if(!/^(?:id|doi|pii|article|articleid|articlenumber|download|format|sequence|isallowed|attachment|verb|metadataprefix|from|until|feed|jc|type)$/i.test(key)||!/^[-\w./:]+$/.test(value))return undefined;
  }
  if(url.hash&&!/^#page=\d+$/.test(url.hash))url.hash='';
  return url.href;
 }catch{return undefined;}
}

function plain(value:string):string {
 return redactSecrets(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g,'')
  .replace(/(?:\b[a-z]:[\\/]|\\\\)[^\r\n"'<>]+|\/(?:home|Users|private|tmp|var|mnt)\/[^\s"'<>]+/gi,'[private path withheld]')
  .replace(/https?:\/\/[^\s<>"']+/gi,url=>safePublicUrl(url)||'[link withheld]');
}
function licensed(value?:string):string|undefined {
 if(!value)return undefined;
 const label=value.trim().toLowerCase().replace(/\s+/g,'-');
 if(['cc-by','cc-by-sa','cc0'].includes(label))return {'cc-by':'CC BY','cc-by-sa':'CC BY-SA',cc0:'CC0'}[label];
 const short=/^cc-(by|by-sa)-(1\.0|2\.0|2\.5|3\.0|4\.0)$/.exec(label);
 if(short)return `https://creativecommons.org/licenses/${short[1]}/${short[2]}/`;
 if(label==='cc0-1.0')return 'https://creativecommons.org/publicdomain/zero/1.0/';
 try {
  const url=new URL(value);
  if(!['http:','https:'].includes(url.protocol)||url.hostname!=='creativecommons.org'||url.username||url.password||url.port||url.search||url.hash)return undefined;
  const match=/^\/licenses\/(by|by-sa)\/(1\.0|2\.0|2\.5|3\.0|4\.0)\/?$/.exec(url.pathname);
  if(match)return `https://creativecommons.org/licenses/${match[1]}/${match[2]}/`;
  if(/^\/publicdomain\/zero\/1\.0\/?$/.test(url.pathname))return 'https://creativecommons.org/publicdomain/zero/1.0/';
 }catch{}
 return undefined;
}
function official(value:string,publisher:Journal['publisher']):boolean {
 const safe=safePublicUrl(value);if(!safe)return false;
 const host=new URL(safe).hostname;
 return publisher==='wiley'?/(^|\.)onlinelibrary\.wiley\.com$/.test(host):publisher==='elsevier'?/(^|\.)sciencedirect\.com$/.test(host)||host==='api.elsevier.com':publisher==='sage'?host==='journals.sagepub.com':host==='learning-analytics.info';
}
function sameUrl(a?:string,b?:string):boolean {
 const left=safePublicUrl(a),right=safePublicUrl(b);if(!left||!right)return false;
 const normalize=(value:string)=>{const url=new URL(value);url.hash='';return url.href.replace(/\/$/,'');};
 return normalize(left)===normalize(right);
}
function paperLocation(p:InputPaper,location:InputLocation):boolean {
 if(sameUrl(p.url,location.url))return true;
 const candidate=safePublicUrl(location.url);if(!candidate)return false;
 const pathname=decodeURIComponent(new URL(candidate).pathname).toLowerCase();
 if(p.doi&&pathname.endsWith('/'+p.doi.toLowerCase().replace(/^https?:\/\/doi\.org\//,'')))return true;
 if(p.pii&&/^[a-z0-9]+$/i.test(p.pii)&&new RegExp('/pii/'+p.pii.toLowerCase()+'(?:/|$)').test(pathname))return true;
 const article=/\/article\/(?:view|download)\/(\d+)(?:\/|$)/.exec(new URL(safePublicUrl(p.url)||'https://invalid.invalid').pathname);
 return Boolean(article&&new RegExp('/article/(?:view|download)/'+article[1]+'(?:/|$)').test(pathname));
}
async function verifiedDownload(p:InputPaper,output:string):Promise<boolean> {
 if(p.pdf.status!=='downloaded'||!p.pdf.path||!/^[a-f0-9]{64}$/.test(p.pdf.sha256||'')||!safePublicUrl(p.pdf.sourceUrl))return false;
 try {
  const archive=await realpath(output);
  const base=await realpath(path.join(output,'pdf'));
  const archiveRelative=path.relative(archive,base);
  if(!archiveRelative||archiveRelative==='..'||archiveRelative.startsWith('..'+path.sep)||path.isAbsolute(archiveRelative))return false;
  const file=await realpath(path.resolve(output,p.pdf.path));const text=await realpath(path.resolve(output,p.pdf.path)+'.txt');
  for(const target of [file,text]){const relative=path.relative(base,target);if(!relative||relative==='..'||relative.startsWith('..'+path.sep)||path.isAbsolute(relative))return false;}
  return createHash('sha256').update(await readFile(file)).digest('hex')===p.pdf.sha256&&(await readFile(text,'utf8')).trim().length>=100;
 }catch{return false;}
}
function exactDoi(value?:string):string|undefined {
 if(!value)return undefined;
 const doi=value.trim().replace(/^https?:\/\/(?:dx\.)?doi\.org\//i,'').replace(/^doi:\s*/i,'').toLowerCase();
 return /^10\.\d{4,9}\/[^\s<>"?#\\]+$/.test(doi)?doi:undefined;
}
/** Only an exact DOI-addressed API record can bind an aggregator abstract to a licence. */
function aggregatorRecord(value?:string):{provider:'crossref'|'openalex';doi:string}|undefined {
 const safe=safePublicUrl(value);if(!safe)return undefined;
 try {
  const url=new URL(value!);
  if(url.protocol!=='https:'||url.search||url.hash||url.port||!url.pathname.startsWith('/works/'))return undefined;
  const provider=url.hostname==='api.crossref.org'?'crossref':url.hostname==='api.openalex.org'?'openalex':undefined;
  if(!provider)return undefined;
  const identifier=decodeURIComponent(url.pathname.slice('/works/'.length));
  if(provider==='openalex'&&!/^https:\/\/doi\.org\//i.test(identifier))return undefined;
  if(provider==='crossref'&&!/^10\./.test(identifier))return undefined;
  const doi=exactDoi(identifier);return doi?{provider,doi}:undefined;
 }catch{return undefined;}
}
function crossrefAbstractLicense(p:InputPaper,asOf:string):{license:string;source:string}|undefined {
 const doi=exactDoi(p.doi),record=aggregatorRecord(p.abstractSource);
 if(!p.abstract||!p.authors.length||!doi||!record||record.doi!==doi)return undefined;
 const hasAbstractProvenance=p.provenance.some(item=>{
  const source=aggregatorRecord(item.url);
  return item.source===record.provider&&source?.provider===record.provider&&source.doi===doi&&sameUrl(item.url,p.abstractSource);
 });
 if(!hasAbstractProvenance)return undefined;
 const eligible=(p.licenses||[]).filter(proof=>{
  const source=aggregatorRecord(proof.sourceUrl);
  if(proof.source!=='crossref'||proof.appliesTo!=='vor'||exactDoi(proof.doi)!==doi||source?.provider!=='crossref'||source.doi!==doi||Date.parse(proof.fetchedAt)>Date.parse(asOf))return false;
  if(proof.start&&dateInterval(proof.start.value)!.end>asOf.slice(0,10))return false;
  return p.provenance.some(item=>item.source==='crossref'&&sameUrl(item.url,proof.sourceUrl)&&item.fetchedAt===proof.fetchedAt);
 });
 if(!eligible.length)return undefined;
 // Licence changes have their own effective dates. Do not fall back to an older
 // permissive licence when the current VoR terms are absent or nonpermissive.
 const latest=eligible.reduce((date,proof)=>{const start=proof.start?dateInterval(proof.start.value)!.end:'';return start>date?start:date;},'');
 const current=eligible.filter(proof=>(proof.start?dateInterval(proof.start.value)!.end:'')===latest);
 const permissions=current.map(proof=>safePublicUrl(proof.url)&&licensed(proof.url));
 if(permissions.some(permission=>!permission))return undefined;
 return {license:permissions[0]!,source:safePublicUrl(current[0].sourceUrl)!};
}
async function abstractLicense(p:InputPaper,publisher:Journal['publisher'],output:string):Promise<string|undefined> {
 if(!p.abstract||!p.abstractSource||!p.authors.length)return undefined;
 // JLA's author copyright policy explicitly licences the published work under
 // CC BY 4.0: https://learning-analytics.info/index.php/JLA/about/submissions
 // Match the exact Crossref DOI record plus article-specific official OAI rights;
 // neither an aggregator's availability nor an unrelated repository licence suffices.
 const crossref=p.doi?`https://api.crossref.org/works/${encodeURIComponent(p.doi.trim().toLowerCase())}`:undefined;
 if(publisher==='jla'&&crossref&&p.abstractSource===crossref
  &&p.provenance.some(item=>item.source==='crossref'&&item.url===crossref)
  &&p.provenance.some(item=>item.source==='jla-oai'&&official(item.url,'jla')&&new URL(item.url).pathname==='/index.php/JLA/oai')
  &&p.oaLocations.some(item=>item.isOa&&item.hostType==='publisher'&&item.version==='publishedVersion'&&item.source==='JLA OAI rights'
   &&licensed(item.license)==='https://creativecommons.org/licenses/by/4.0/'&&official(item.url,'jla')&&sameUrl(item.url,p.url)))return 'https://creativecommons.org/licenses/by/4.0/';
 // Aggregators do not establish the licence of the particular abstract they reconstructed.
 if(/(?:^|\/\/)api\.(?:openalex|crossref)\.org\//i.test(p.abstractSource))return undefined;
 const isOfficialSource=official(p.abstractSource,publisher);
 const provenance=p.provenance.some(item=>official(item.url,publisher));
 for(const location of p.oaLocations) {
  const permission=licensed(location.license);if(!location.isOa||!permission)continue;
  if(location.hostType==='publisher'&&official(location.url,publisher)&&paperLocation(p,location)&&isOfficialSource&&provenance) {
   const source=safePublicUrl(p.abstractSource)!;
   const isFeed=p.provenance.some(item=>sameUrl(item.url,source)&&/^(publisher-rss|jla-oai)$/.test(item.source));
   if(sameUrl(source,location.url)||sameUrl(source,location.pdfUrl)||paperLocation(p,{...location,url:source})||isFeed)return permission;
  }
  // A repository licence can authorize only this exact recovered repository text,
  // never a publisher/feed abstract from another version or location.
  if(location.hostType==='repository'&&sameUrl(p.abstractSource,location.pdfUrl)&&sameUrl(p.abstractSource,p.pdf.sourceUrl)&&await verifiedDownload(p,output))return permission;
 }
 return undefined;
}
const reasons={both:'This paper relates to learning analytics and artificial intelligence.','learning-analytics':'This paper relates to learning analytics.',ai:'This paper relates to artificial intelligence.'};
const versions=new Set(['publishedVersion','acceptedVersion','submittedVersion']);
function publicDate(value?:PaperDate):PaperDate|undefined{return value?{value:value.value,precision:value.precision,source:'Publication metadata'}:undefined;}

export async function createPublicLibrary(input:unknown,output:string,asOf=new Date().toISOString()):Promise<Library> {
 if(!timestamp.safeParse(asOf).success)throw new Error('Invalid public export time');
 const exportTime=new Date(asOf).toISOString();
 const parsed=inputSchema.parse(input);
 const papers:Paper[]=[];
 for(const p of parsed.papers) {
  if(!['both','learning-analytics','ai'].includes(p.relevance.topic)||isExcluded(p))continue;
  const journal=parsed.journals.find(journal=>journal.id===p.journalId)!;
  const crossrefPermission=crossrefAbstractLicense(p,exportTime);
  const license=crossrefPermission?.license??await abstractLicense(p,journal.publisher,output);
  const summaryOk=Boolean(p.summary&&p.summaryGeneratedAt&&p.relevance.method==='codex'&&p.summary.trim().split(/\s+/).length>=150&&p.summary.trim().split(/\s+/).length<=250&&sameUrl(p.summarySource,p.pdf.sourceUrl)&&await verifiedDownload(p,output));
  const topic=p.relevance.topic as keyof typeof reasons;
  const oaLocations=p.oaLocations.filter(item=>item.isOa&&safePublicUrl(item.url)).map(item=>({url:safePublicUrl(item.url)!,pdfUrl:safePublicUrl(item.pdfUrl),hostType:item.hostType,version:versions.has(item.version||'')?item.version:undefined,license:licensed(item.license),isOa:true,source:'Public OA metadata'}));
  const paper:Paper={id:plain(p.id),doi:p.doi?plain(p.doi):undefined,pii:p.pii?plain(p.pii):undefined,aliases:[],journalId:p.journalId,title:plain(p.title),authors:p.authors.map(plain),url:safePublicUrl(p.url)||'',keywords:p.keywords.map(plain),articleType:plain(p.articleType),
   publishedOnline:publicDate(p.publishedOnline),publishedIssue:publicDate(p.publishedIssue),publicationDate:publicDate(p.publicationDate),volume:p.volume?plain(p.volume):undefined,issue:p.issue?plain(p.issue):undefined,pages:p.pages?plain(p.pages):undefined,
   firstSeenAt:p.firstSeenAt,updatedAt:p.updatedAt,relevance:{topic,method:p.relevance.method,confidence:p.relevance.confidence,reason:reasons[topic],evidence:[]},oaLocations,
   pdf:{status:'unavailable',sourceUrl:safePublicUrl(p.pdf.sourceUrl),license:licensed(p.pdf.license),version:versions.has(p.pdf.version||'')?p.pdf.version:undefined},
   milestones:p.milestones.map(item=>({kind:item.kind,observedAt:item.observedAt,date:item.date})),provenance:[],publicContent:{abstract:p.abstract?(license?'licensed':'withheld'):'unavailable',license,...(crossrefPermission?{licenseSource:crossrefPermission.source}:{})},
  };
  if(license){paper.abstract=plain(p.abstract!);paper.abstractSource=safePublicUrl(p.abstractSource);}
  if(summaryOk){paper.summary=plain(p.summary!);paper.summarySource=safePublicUrl(p.summarySource);paper.summaryGeneratedAt=p.summaryGeneratedAt;}
  papers.push(paper);
 }
 const sources:SourceHealth[]=parsed.sources.map(item=>({journalId:item.journalId,status:item.status,checkedAt:item.checkedAt,lastSuccessAt:item.lastSuccessAt,discovered:item.discovered,errors:item.status==='failed'?['The source check was unsuccessful.']:item.status==='partial'?['Some source checks were unavailable.']:[]}));
 return {schemaVersion:1,generatedAt:parsed.generatedAt,coverageStart:parsed.coverageStart,journals:parsed.journals.map(journal=>({id:journal.id,name:plain(journal.name),shortName:plain(journal.shortName),issn:plain(journal.issn),publisher:journal.publisher,url:safePublicUrl(journal.url)||'',feeds:[]})),papers,sources};
}
function overview(library:Library):string {
 const esc=(value:string)=>value.replace(/&/g,'&amp;').replace(/[\\`*_{}\[\]()#+.!|<>:\-]/g,'\\$&').replace(/[\r\n]+/g,' ');
 return ['# Paper Monitor public library','',`Updated: ${esc(library.generatedAt)}`,`Coverage: ${esc(library.coverageStart)} onward`,`${library.papers.length} relevant papers.`,`${library.papers.filter(p=>p.abstract).length} abstracts with supported redistribution licences.`,`${library.papers.filter(p=>p.summary).length} clearly labeled generated summaries.`, '', 'Public files contain bibliographic metadata and permitted text only. PDFs and private local reports are not published.', '', '## Journal checks','',...library.journals.map(journal=>`- ${esc(journal.name)}: ${library.sources.find(source=>source.journalId===journal.id)?.status||'never'}`),''].join('\n');
}
export async function exportPublicLibrary(root=process.cwd()) {
 const base=await realpath(path.resolve(root));
 const library=await createPublicLibrary(JSON.parse(await readFile(path.join(base,'output','library.json'),'utf8')),path.join(base,'output'));
 // Reject destination directory symlinks before creating/replacing public artifacts.
 let directory=base;
 for(const part of ['public-site','data']){directory=path.join(directory,part);try{if((await lstat(directory)).isSymbolicLink())throw new Error('Public export destination cannot be a symlink');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;await mkdir(directory);}}
 const libraryPath=path.join(directory,'library.json'),overviewPath=path.join(directory,'latest.md');
 const contents={'public-site/data/library.json':JSON.stringify(library,null,2)+'\n','public-site/data/latest.md':overview(library)};
 await atomicWrite(overviewPath,contents['public-site/data/latest.md']);
 await atomicWrite(libraryPath,contents['public-site/data/library.json']);
 return {libraryPath,overviewPath,contents,paperCount:library.papers.length,licensedAbstracts:library.papers.filter(p=>p.abstract).length,withheldAbstracts:library.papers.filter(p=>p.publicContent?.abstract==='withheld').length,generatedSummaries:library.papers.filter(p=>p.summary).length};
}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url) {
 exportPublicLibrary().then(result=>process.stdout.write(`Public export: ${result.paperCount} papers; ${result.licensedAbstracts} licensed abstracts; ${result.withheldAbstracts} abstracts withheld; ${result.generatedSummaries} generated summaries.\n`)).catch(()=>{process.stderr.write('Public export failed. The local archive or export destination is invalid; no private diagnostics were published.\n');process.exitCode=1;});
}
