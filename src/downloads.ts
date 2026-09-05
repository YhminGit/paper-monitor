import { mkdir, readFile, stat, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { OUTPUT } from './config.js';
import type { Paper } from './types.js';
import { paperId } from './identity.js';
import { fetchRemote, safeError } from './http.js';
import { readJson, writeJson, atomicWrite } from './storage.js';

export function downloadTarget(p:Paper,output=OUTPUT) {
 const year=(p.publicationDate?.value||p.firstSeenAt).slice(0,4);
 return path.join(output,'pdf',p.journalId,year,`${paperId(p.id)}.pdf`);
}
/** Recover only a clearly delimited author abstract; never summarize or guess boundaries. */
export function extractAuthorAbstract(text:string):{abstract:string;page:number}|undefined {
 const start=/(?:^|\s)(?:ABSTRACT|A\s+B\s+S\s+T\s+R\s+A\s+C\s+T)\s*[:.]?\s+/i.exec(text);
 if(!start)return;
 const tail=text.slice(start.index+start[0].length);
 const end=/\s+(?:1\s*[.:]?\s+(?:Introduction|Background)\b|(?:Keywords|Key\s+words)\s*[:：]|Introduction\s*[.:]?\s)/i.exec(tail);
 if(!end)return;
 const abstract=tail.slice(0,end.index).replace(/\s+/g,' ').trim();
 const words=abstract.split(/\s+/).length;
 if(words<60||words>600||/\[Page \d+\]/.test(abstract))return;
 const pages=[...text.slice(0,start.index).matchAll(/\[Page (\d+)\]/g)];
 return {abstract,page:Number(pages.at(-1)?.[1]||1)};
}
export async function recoverAuthorAbstract(p:Paper,output=OUTPUT) {
 if(p.abstract||p.pdf.status!=='downloaded'||!p.pdf.path||!p.pdf.sourceUrl)return;
 const extracted=await readFile(path.resolve(output,p.pdf.path)+'.txt','utf8').catch(()=>undefined);
 const recovered=extracted&&extractAuthorAbstract(extracted);
 if(recovered){p.abstract=recovered.abstract;p.abstractSource=p.pdf.sourceUrl.split('#')[0]+`#page=${recovered.page}`;}
}

export async function extractPdf(file: string): Promise<{pages:number;text:string}> {
 const bytes = new Uint8Array(await readFile(file));
 if(Buffer.from(bytes.subarray(0,1024)).indexOf('%PDF-')<0) throw new Error('Downloaded response is not a PDF');
 if(!Buffer.from(bytes.subarray(Math.max(0,bytes.length-2048))).includes(Buffer.from('%%EOF')))throw new Error('PDF is incomplete: terminal EOF marker is missing');
 const {getDocument}=await import('pdfjs-dist/legacy/build/pdf.mjs');
 const task=getDocument({data:bytes,useSystemFonts:true,disableFontFace:true});
 const doc=await task.promise;
 try {
  const text:string[]=[];
  for(let n=1;n<=Math.min(doc.numPages,150);n++) {
   const page=await doc.getPage(n);const content=await page.getTextContent();
   text.push(`\n[Page ${n}]\n`+content.items.map((x:any)=>x.str||'').join(' '));
  }
  return {pages:doc.numPages,text:text.join('\n')};
 } finally {await task.destroy();}
}
export async function downloadPaper(p: Paper, output=OUTPUT, request:typeof fetchRemote=fetchRemote): Promise<string|undefined> {
 const now=new Date().toISOString();
 if(p.pdf.status==='downloaded'&&p.pdf.path) {
  const file=path.resolve(output,p.pdf.path);
  try {await stat(file);await recoverAuthorAbstract(p,output);return file;}catch{}
 }
 const locations=p.oaLocations.filter(l=>l.isOa&&l.pdfUrl).sort((a,b)=>Number(b.hostType==='publisher')-Number(a.hostType==='publisher')||Number(b.version==='publishedVersion')-Number(a.version==='publishedVersion'));
 if(!locations.length) {p.pdf={status:'unavailable',attemptedAt:now,error:p.oaLocations.some(x=>x.isOa)?'Open-access landing page found; no direct PDF available.':'No verified open-access PDF location found.'};return;}
 const target=downloadTarget(p,output);const relative=path.relative(output,target);
 await mkdir(path.dirname(target),{recursive:true});
 const failures:string[]=[];
 for(const location of locations) {
  const source=location.pdfUrl!;const part=target+'.part';const metaFile=part+'.json';
  try {
   const meta=await readJson<{url?:string;etag?:string;modified?:string;expectedTotal?:number}>(metaFile,{});
   let size=await stat(part).then(x=>x.size).catch(()=>0);
   // A prior process may have finished transfer but stopped during validation/publication.
   if(size>0&&meta.url===source) {
    try {
     const bytes=await readFile(part);
     if((meta.expectedTotal===undefined||size===meta.expectedTotal)&&bytes.subarray(Math.max(0,bytes.length-2048)).includes(Buffer.from('%%EOF'))) {
      const recovered=await extractPdf(part);
      await rename(part,target);await unlink(metaFile).catch(()=>{});
      if(recovered.text.trim().length>100)await atomicWrite(target+'.txt',recovered.text);
      p.pdf={status:'downloaded',path:relative,sourceUrl:source,sha256:createHash('sha256').update(bytes).digest('hex'),bytes:bytes.length,license:location.license,version:location.version,attemptedAt:now};
      await recoverAuthorAbstract(p,output);
      return target;
     }
    }catch{/* A partial PDF continues through range retrieval below. */}
   }
   if(meta.url!==source || (!meta.etag&&!meta.modified))size=0;
   const headers:Record<string,string>={Accept:'application/pdf'};
   if(size>0){headers.Range=`bytes=${size}-`;headers['If-Range']=meta.etag||meta.modified!;}
   let response=await request(source,{headers});
   if(response.status===416) {await response.body?.cancel();size=0;response=await request(source,{headers:{Accept:'application/pdf'}});}
   const append=response.status===206&&size>0;
   const range=response.status===206?/^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range')||''):null;
   if(response.status===206&&(!range||Number(range[1])!==size||Number(range[2])<size||Number(range[3])<=Number(range[2]))) {
    await response.body?.cancel();throw new Error('Invalid partial-content response');
   }
   if(!append)size=0;
   const mime=response.headers.get('content-type')||'';
   if(!/pdf|octet-stream/i.test(mime)) {await response.body?.cancel();throw new Error(`Source returned ${mime||'unknown content type'} instead of a PDF`);}
   const max=100*1024*1024;
   const expectedLength=response.headers.has('content-length')&&!response.headers.get('content-encoding')?Number(response.headers.get('content-length')):undefined;
   if((expectedLength??0)+size>max || range&&Number(range[3])>max) {await response.body?.cancel();throw new Error('PDF exceeds 100 MB per-file limit');}
   await writeJson(metaFile,{url:source,etag:response.headers.get('etag')||undefined,modified:response.headers.get('last-modified')||undefined,expectedTotal:range?Number(range[3]):expectedLength===undefined?undefined:size+expectedLength});
   if(!response.body)throw new Error('Empty PDF response');
   const startSize=size;
   const handle=await open(part,append?'a':'w');
   try {for await (const chunk of response.body as any){size+=chunk.length;if(size>max)throw new Error('PDF exceeds 100 MB per-file limit');await handle.writeFile(chunk);}}finally{await handle.close();}
   if(expectedLength!==undefined&&size-startSize!==expectedLength)throw new Error('Incomplete PDF transfer: Content-Length mismatch');
   if(range&&(size!==Number(range[2])+1||size!==Number(range[3])))throw new Error('Incomplete PDF transfer: Content-Range total mismatch');
   const extracted=await extractPdf(part);
   const buffer=await readFile(part); const sha256=createHash('sha256').update(buffer).digest('hex');
   await rename(part,target);await unlink(metaFile).catch(()=>{});
   if(extracted.text.trim().length>100)await atomicWrite(target+'.txt',extracted.text);
   p.pdf={status:'downloaded',path:relative,sourceUrl:source,sha256,bytes:buffer.length,license:location.license,version:location.version,attemptedAt:now};
   await recoverAuthorAbstract(p,output);
   return target;
  } catch(error) {failures.push(safeError(error));}
 }
 p.pdf={status:failures.some(x=>/HTTP 40[13]|HTTP 429/.test(x))?'blocked':'failed',sourceUrl:locations[0].pdfUrl,error:failures.join('; ').slice(0,800),attemptedAt:now};
}
