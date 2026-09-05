import assert from 'node:assert/strict';
import test from 'node:test';
import type { LookupAddress, LookupOptions } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import { createPublicLookup, fetchRemote, publicAddress, redactSecrets, safeError, validateRemoteUrl } from '../src/http.js';

function resolveWith(lookup:LookupFunction, options:LookupOptions={all:true}) {
 return new Promise<{address:string|LookupAddress[];family?:number}>((resolve,reject)=>{
  lookup('publisher.example',options,(error,address,family)=>error?reject(error):resolve({address,family}));
 });
}

test('publicAddress rejects private, loopback, multicast, reserved and disguised IPv4 addresses',()=>{
 const blocked=['0.0.0.0','0.1.2.3','10.0.0.1','127.0.0.1','127.255.255.255','169.254.169.254','172.16.0.1','172.31.255.255','192.168.1.1','100.64.0.1','100.127.255.255','192.0.0.1','192.0.2.1','192.88.99.1','198.18.0.1','198.19.255.255','198.51.100.1','203.0.113.1','224.0.0.1','239.255.255.255','240.0.0.1','255.255.255.255','127.1','0177.0.0.1','0x7f000001','2130706433','not-an-address',''];
 for(const address of blocked)assert.equal(publicAddress(address),false,address);
 for(const address of ['1.1.1.1','8.8.8.8','93.184.216.34','172.15.255.255','172.32.0.1','100.63.255.255','100.128.0.1'])assert.equal(publicAddress(address),true,address);
});

test('publicAddress normalizes IPv6 and fails closed for local and transition ranges',()=>{
 const blocked=['::','::1','0:0:0:0:0:0:0:1','0000:0000:0000:0000:0000:0000:0000:0001','::ffff:127.0.0.1','0:0:0:0:0:ffff:7f00:1','::ffff:8.8.8.8','fc00::1','FD00::1','fe80::1','fe90::1','febf::1','ff02::1','2001:db8::1','2001:0db8:0000::1','2001::1','2002:7f00:1::1','64:ff9b::7f00:1','3fff::1','fe80::1%eth0'];
 for(const address of blocked)assert.equal(publicAddress(address),false,address);
 for(const address of ['2606:4700:4700::1111','2001:4860:4860::8888','2a00:1450:4001::1'])assert.equal(publicAddress(address),true,address);
});

test('remote URL validation rejects unsafe URL forms without contacting the network',async()=>{
 const blocked=['http://8.8.8.8/paper','file:///C:/private/key','javascript:alert(1)','data:text/html,bad','https://user:pass@8.8.8.8/paper','https://user@8.8.8.8/paper','https://8.8.8.8:8443/paper','https://127.0.0.1/paper','https://127.1/paper','https://2130706433/paper','https://0x7f000001/paper','https://0177.0.0.1/paper','https://169.254.169.254/latest/meta-data','https://[::1]/paper','https://[0:0:0:0:0:0:0:1]/paper','https://[::ffff:127.0.0.1]/paper','https://192.0.2.1/paper'];
 for(const url of blocked)await assert.rejects(validateRemoteUrl(url),error=>error instanceof Error,url);
 assert.equal((await validateRemoteUrl('https://8.8.8.8:443/paper?q=one')).href,'https://8.8.8.8/paper?q=one');
 assert.equal((await validateRemoteUrl('https://[2606:4700:4700::1111]/paper')).hostname,'[2606:4700:4700::1111]');
});

test('secret redaction covers configured literals, escaped JSON and encoded variants without invalidating JSON',()=>{
 const keys=['ELSEVIER_API_KEY','OPENALEX_API_KEY','CONTACT_EMAIL'];
 const prior=keys.map(key=>process.env[key]);
 process.env.ELSEVIER_API_KEY='elsevier/private+key';
 process.env.OPENALEX_API_KEY='openalex\\"private';
 process.env.CONTACT_EMAIL='researcher+alerts@example.org';
 try {
  const secrets=keys.map(key=>process.env[key]!);
  const data={title:secrets.join(' '),nested:{error:secrets.map(encodeURIComponent).join(' '),email:process.env.CONTACT_EMAIL},unchanged:'Article title'};
  const output=redactSecrets(JSON.stringify(data));
  assert.doesNotThrow(()=>JSON.parse(output));
  for(const secret of secrets) {
   assert.ok(!output.includes(secret));
   assert.ok(!output.includes(encodeURIComponent(secret)));
   assert.ok(!output.includes(JSON.stringify(secret).slice(1,-1)));
  }
  assert.equal(JSON.parse(output).unchanged,'Article title');
  assert.ok(output.includes('[redacted]'));
 }finally{keys.forEach((key,index)=>{if(prior[index]===undefined)delete process.env[key];else process.env[key]=prior[index];});}
});

test('unknown credentials in source errors are redacted and safeError remains bounded',()=>{
 const input='https://api.example/paper?api_key=one&APIKey=two&mailto=three&email=four&access_token=five&token=six&secret=seven Authorization: Bearer eight X-ELS-APIKey: nine';
 const output=redactSecrets(input);
 for(const secret of ['one','two','three','four','five','six','seven','eight','nine'])assert.ok(!output.includes(secret),secret);
 assert.equal(output.match(/\[redacted\]/g)?.length,9);
 assert.equal(safeError(new Error('x'.repeat(900))).length,400);
 assert.equal(safeError('simple failure'),'simple failure');
 assert.ok(!safeError(new Error('Authorization: Bearer private-token')).includes('private-token'));
});

test('connection lookup hands the socket exactly one validated DNS result set',async()=>{
 const answers=[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}];
 let calls=0;
 const lookup=createPublicLookup(async(hostname,options)=>{
  calls++;
  assert.equal(hostname,'publisher.example');
  assert.deepEqual(options,{all:true,family:0,hints:0,order:'verbatim'});
  return answers;
 });
 const all=await resolveWith(lookup);
 assert.deepEqual(all.address,answers);
 assert.notEqual(all.address,answers);
 assert.notEqual((all.address as LookupAddress[])[0],answers[0]);
 assert.equal(calls,1);
 answers[0].address='127.0.0.1';
 assert.equal((all.address as LookupAddress[])[0].address,'8.8.8.8','the returned addresses are pinned, not mutable resolver records');
});

test('connection lookup checks every family before applying the requested socket family',async()=>{
 const lookup=createPublicLookup(async()=>[{address:'8.8.8.8',family:4},{address:'2606:4700:4700::1111',family:6}]);
 assert.deepEqual(await resolveWith(lookup,{family:4}),{address:'8.8.8.8',family:4});
 assert.deepEqual(await resolveWith(lookup,{family:'IPv6'}),{address:'2606:4700:4700::1111',family:6});
 assert.deepEqual((await resolveWith(lookup,{family:6,all:true})).address,[{address:'2606:4700:4700::1111',family:6}]);
 const mixed=createPublicLookup(async()=>[{address:'8.8.8.8',family:4},{address:'::1',family:6}]);
 await assert.rejects(resolveWith(mixed,{family:4}),/Private or reserved destination rejected at connection time/);
 const onlyV4=createPublicLookup(async()=>[{address:'8.8.8.8',family:4}]);
 await assert.rejects(resolveWith(onlyV4,{family:6}),/No public address in the requested address family/);
});

test('DNS rebinding after a successful earlier lookup cannot authorize a private connection',async()=>{
 let calls=0;
 const resolver=async()=>++calls===1?[{address:'8.8.8.8',family:4}]:[{address:'127.0.0.1',family:4}];
 const earlier=await resolver();
 assert.ok(earlier.every(entry=>publicAddress(entry.address)));
 const connectionLookup=createPublicLookup(resolver);
 await assert.rejects(resolveWith(connectionLookup),/rejected at connection time/);
 assert.equal(calls,2);
});

test('connection lookup rejects empty, mixed-private and malformed answers and preserves DNS failures',async()=>{
 for(const answers of [[],[{address:'10.0.0.1',family:4}],[{address:'8.8.8.8',family:4},{address:'169.254.169.254',family:4}],[{address:'8.8.8.8',family:6}],[{address:'not-an-ip',family:4}]]) {
  await assert.rejects(resolveWith(createPublicLookup(async()=>answers)),/rejected at connection time/);
 }
 const failure=Object.assign(new Error('Fixture DNS unavailable'),{code:'ENOTFOUND'});
 await assert.rejects(resolveWith(createPublicLookup(async()=>{throw failure;})),error=>error===failure);
});

test('Undici invokes the guarded lookup and rejects a private answer before opening a connection',async()=>{
 let lookups=0;
 const agent=new Agent({autoSelectFamily:true,connect:{rejectUnauthorized:true,lookup:createPublicLookup(async()=>{lookups++;return [{address:'127.0.0.1',family:4}];})}});
 try {
  const options:RequestInit&{dispatcher:Agent}={dispatcher:agent,signal:AbortSignal.timeout(1000)};
  await assert.rejects(fetch('https://unresolvable-fixture.invalid/paper',options),error=>{
   assert.ok(error instanceof TypeError);
   assert.match(String(error.cause),/rejected at connection time/);
   return true;
  });
  assert.equal(lookups,1);
 }finally{await agent.close();}
});

test('fetchRemote installs its private Agent and cannot accept a caller dispatcher override',async(t)=>{
 const override={dispatch:()=>{throw new Error('UNSAFE DISPATCHER MUST NOT RUN');}};
 let seen=false;
 t.mock.method(globalThis,'fetch',async(url:URL,options:RequestInit&{dispatcher:unknown})=>{
  seen=true;
  assert.equal(url.href,'https://8.8.8.8/paper');
  assert.ok(options.dispatcher instanceof Agent);
  assert.notEqual(options.dispatcher,override);
  assert.equal(options.redirect,'manual');
  assert.ok(options.signal);
  assert.equal(new Headers(options.headers).get('Accept'),'application/pdf');
  return new Response('offline fixture');
 });
 const options:RequestInit&{dispatcher:unknown}={dispatcher:override,redirect:'follow',headers:{Accept:'application/pdf'}};
 assert.equal(await (await fetchRemote('https://8.8.8.8/paper',options)).text(),'offline fixture');
 assert.equal(seen,true);
});
