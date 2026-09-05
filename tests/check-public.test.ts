import test from 'node:test';
import assert from 'node:assert/strict';
import {checkPublicSnapshot} from '../src/check-public.js';
const fixture=()=>({schemaVersion:1,journals:[{feeds:[]}],sources:[],papers:[{id:'doi:10.1/paper',title:'Public paper',authors:['Author'],relevance:{topic:'ai',evidence:[]},aliases:[],provenance:[],pdf:{status:'unavailable'},publicContent:{abstract:'unavailable'}}]});
test('public build gate accepts sanitized metadata but rejects private additions',()=>{
  checkPublicSnapshot(fixture());
  for(const addition of [{path:'pdf/local.pdf'},{credentials:{}},{runId:'private-run'}])assert.throws(()=>checkPublicSnapshot({...fixture(),...addition}),/private field/);
  for(const text of ['http://127.0.0.1:3000','C:\\Users\\private\\paper.pdf','https://example.org/paper?api_key=private']){
    const l=fixture();l.papers[0].title=text;assert.throws(()=>checkPublicSnapshot(l));
  }
});
test('public build gate rejects hidden review evidence, unlicensed abstracts and local PDF state',()=>{
  const abstract:any=fixture();abstract.papers[0].abstract='Not licensed';assert.throws(()=>checkPublicSnapshot(abstract),/licence/);
  const evidence:any=fixture();evidence.papers[0].relevance.evidence=['Private extracted text'];assert.throws(()=>checkPublicSnapshot(evidence),/Private/);
  const pdf:any=fixture();pdf.papers[0].pdf.status='downloaded';assert.throws(()=>checkPublicSnapshot(pdf),/Local PDF/);
});
