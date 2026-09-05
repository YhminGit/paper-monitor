import { lookup } from 'node:dns/promises';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { isIP, type LookupFunction } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { Agent } from 'undici';

export function publicAddress(address: string): boolean {
 const a = address.toLowerCase();
 if(a.includes('%'))return false;
 if (isIP(a) === 4) {
  const [x,y,z] = a.split('.').map(Number);
  return !(x === 0 || x === 10 || x === 127 || x >= 224 || (x === 169 && y === 254) || (x === 172 && y >= 16 && y <= 31) || (x === 192 && (y === 168 || y === 0 || y === 88&&z === 99)) || (x === 100 && y >= 64 && y <= 127) || (x === 198 && (y === 18 || y === 19 || y === 51&&z === 100)) || (x === 203&&y === 0&&z === 113));
 }
 if (isIP(a) === 6) {
  const canonical=new URL(`https://[${a}]/`).hostname.slice(1,-1);
  // Fail closed outside global unicast; reject special-purpose/documentation/transition space.
  return /^[23]/.test(canonical)&&!/^2001:(?:[0-1]?[0-9a-f]{1,2}:|db8:)/.test(canonical)&&!canonical.startsWith('2001::')&&!canonical.startsWith('2002:')&&!/^3fff:/.test(canonical);
 }
 return false;
}
export async function validateRemoteUrl(input: string): Promise<URL> {
 const url = new URL(input);
 if (url.protocol !== 'https:' || url.username || url.password || (url.port && url.port !== '443')) throw new Error('Only public HTTPS sources are supported');
 const hostname = url.hostname.replace(/^\[|\]$/g,'');
 const addresses = isIP(hostname) ? [{address:hostname}] : await lookup(hostname, {all:true});
 if (!addresses.length || addresses.some(x=>!publicAddress(x.address))) throw new Error('Private or reserved destination rejected');
 return url;
}

type AddressResolver = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

/** Resolve at socket creation and pass only those exact, validated addresses to Node. */
export function createPublicLookup(resolveAddresses: AddressResolver = lookup): LookupFunction {
 return (hostname, options, callback) => {
  // Always inspect every family, even when the socket requests only IPv4 or IPv6.
  // Filtering before this check could conceal a private fallback DNS record.
  const resolved = Promise.resolve().then(() => resolveAddresses(hostname, { all:true, family:0, hints:0, order:'verbatim' })).then(addresses => {
   if(!addresses.length || addresses.some(entry => !publicAddress(entry.address) || isIP(entry.address)!==entry.family)) {
    throw Object.assign(new Error('Private or reserved destination rejected at connection time'), { code:'EPERM' });
   }
   const family = options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : options.family || 0;
   const selected = addresses.filter(entry => !family || entry.family===family).map(entry => ({ address:entry.address, family:entry.family }));
   if(!selected.length)throw Object.assign(new Error('No public address in the requested address family'), { code:'EAI_ADDRFAMILY' });
   return selected;
  });
  void resolved.then(addresses => {
   if(options.all)callback(null, addresses);
   else callback(null, addresses[0].address, addresses[0].family);
  }, error => callback(error instanceof Error ? error : new Error(safeError(error)), ''));
 };
}

// A private dispatcher prevents global fetch/proxy configuration from replacing
// the connection-time lookup. Hostname/SNI and certificate verification stay intact.
const remoteAgent = new Agent({ autoSelectFamily:true, connect:{ lookup:createPublicLookup(), rejectUnauthorized:true } });
export function redactSecrets(input:string):string {
 let value=input;
 const variants=[process.env.ELSEVIER_API_KEY,process.env.OPENALEX_API_KEY,process.env.CONTACT_EMAIL].filter((x):x is string=>Boolean(x)).flatMap(x=>[x,encodeURIComponent(x),encodeURI(x),JSON.stringify(x).slice(1,-1)]);
 for(const secret of [...new Set(variants)].sort((a,b)=>b.length-a.length))value=value.split(secret).join('[redacted]');
 return value.replace(/([?&](?:api_key|apikey|mailto|email|access_token|token|secret)=)[^&\s"'<>]+/gi,'$1[redacted]').replace(/(X-ELS-APIKey\s*[:=]\s*)[^\s"',}]+/gi,'$1[redacted]').replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s"',}]+/gi,'$1[redacted]');
}
export function safeError(error: unknown): string {
 return redactSecrets(String(error instanceof Error ? error.message : error)).slice(0,400);
}
const lastRequest = new Map<string, number>();
export async function fetchRemote(input: string, init: RequestInit = {}): Promise<Response> {
 let url = await validateRemoteUrl(input);
 let headers = new Headers(init.headers);
 headers.set('User-Agent', `PaperMonitor/1.0${process.env.CONTACT_EMAIL ? ` (mailto:${process.env.CONTACT_EMAIL})` : ''}`);
 for (let hop=0;hop<6;hop++) {
  let response: Response | undefined;
  for(let attempt=0;attempt<3;attempt++) {
   // One request at a time per source; respect advertised publisher pacing.
   const gap = url.hostname === 'learning-analytics.info' ? 60_000 : 1000;
   const wait = Math.max(0,(lastRequest.get(url.hostname)||0)+gap-Date.now());
   lastRequest.set(url.hostname, Date.now()+wait);
   if(wait) await delay(wait);
   try {
    const requestInit: RequestInit & { dispatcher:Agent } = { ...init, dispatcher:remoteAgent, headers, redirect:'manual', signal:init.signal || AbortSignal.timeout(45_000) };
    response = await fetch(url, requestInit);
    if (![429,502,503,504].includes(response.status) || attempt===2) break;
    const retry = Number(response.headers.get('retry-after'));
    await response.body?.cancel();
    await delay(Number.isFinite(retry) && retry>0 ? Math.min(retry*1000,60_000) : 2000*(attempt+1));
   } catch(error) { if(attempt===2) throw new Error(`${url.hostname}: ${safeError(error)}`); await delay(1000*(attempt+1)); }
  }
  if(!response) throw new Error('Source did not respond');
  if([301,302,303,307,308].includes(response.status)) {
   const target = response.headers.get('location'); await response.body?.cancel();
   if(!target) throw new Error('Redirect has no location');
   const next = await validateRemoteUrl(new URL(target,url).href);
   if(next.origin!==url.origin) { headers = new Headers(headers); headers.delete('Authorization'); headers.delete('X-ELS-APIKey'); headers.delete('Cookie'); }
   url=next; continue;
  }
  if(!response.ok && response.status!==416) { await response.body?.cancel(); throw new Error(`${url.hostname}: HTTP ${response.status}`); }
  return response;
 }
 throw new Error('Too many source redirects');
}
