// Public, release-versioned assets only. Account/API responses never enter here.
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {TENCENT_SPEECH_VOICE_CATALOGUE_PUBLIC as catalogue,TENCENT_SPEECH_VOICE_CATALOGUE_JSON} from './speech-voices.js';
const PUBLIC_FILES=new Set(['/login.html','/workspace.html','/platform.js','/platform.css','/help.html','/favicon.ico','/my-bots.html','/my-bots.js','/my-bots.css']);
const CATALOGUE_PATH=/^\/assets\/speech-voices\.[a-f0-9]{64}\.json$/;
export const isPublicAssetPath=pathname=>PUBLIC_FILES.has(pathname)||CATALOGUE_PATH.test(pathname);
export const contentHash=data=>createHash('sha256').update(data).digest('hex');
export function etagMatches(header,etag){
  if(typeof header!=='string'||header.length>8192)return false;
  return header.split(',').some(value=>value.trim()==='*'||value.trim().replace(/^W\//,'')===etag.replace(/^W\//,''));
}
export function publicAssetHeaders(data,{immutable=false}={}){
  return {'cache-control':immutable?'public, max-age=31536000, immutable':'no-cache',etag:'"'+contentHash(data)+'"','content-length':String(Buffer.byteLength(data))};
}
export function catalogueAsset(req,res,url){
  if(!url.pathname.startsWith('/assets/speech-voices.'))return false;
  const valid=url.pathname===catalogue.url&&!url.search&&['GET','HEAD'].includes(req.method);
  if(!valid){res.writeHead(404,{'cache-control':'no-cache'});res.end();return true;}
  const headers={...publicAssetHeaders(TENCENT_SPEECH_VOICE_CATALOGUE_JSON,{immutable:true}),'content-type':'application/json; charset=utf-8','x-content-type-options':'nosniff'};
  if(etagMatches(req.headers['if-none-match'],headers.etag)){delete headers['content-length'];res.writeHead(304,headers);res.end();return true;}
  res.writeHead(200,headers);res.end(req.method==='HEAD'?undefined:TENCENT_SPEECH_VOICE_CATALOGUE_JSON);return true;
}
export function versionWorkspaceHtml(data,uiDir){
  return Buffer.from(data.toString('utf8').replace(/\b(src|href)=(["'])\/(platform\.(?:js|css))(?:\?[^"']*)?\2/g,(_all,attribute,quote,name)=>`${attribute}=${quote}/${name}?v=${contentHash(fs.readFileSync(path.join(uiDir,name)))}${quote}`));
}
export function matchingAssetVersion(url,data){
  const versions=url.searchParams.getAll('v');
  if(!versions.length)return false;
  return versions.length===1&&[...url.searchParams.keys()].length===1&&versions[0]===contentHash(data);
}
