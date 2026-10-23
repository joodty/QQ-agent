// Bounded response compression at the gateway. Never buffers SSE/audio or asks
// upstreams to compress. Over-limit bodies fall back to their original stream.
import {gzip} from 'node:zlib';
export const COMPRESSION_BODY_LIMIT=2*1024*1024;
export function acceptsGzip(value){
  if(typeof value!=='string'||value.length>8192)return false;
  const entries=value.toLowerCase().split(',').map(part=>{
    const [name,...parameters]=part.trim().split(';');let q=1;
    for(const parameter of parameters){const m=/^\s*q\s*=\s*(0(?:\.\d{0,3})?|1(?:\.0{0,3})?)\s*$/.exec(parameter);if(m)q=Number(m[1]);else if(/^\s*q\s*=/.test(parameter))q=0;}
    return {name,q};
  });
  const specific=entries.filter(row=>row.name==='gzip');
  return specific.length?specific.every(row=>row.q>0):entries.some(row=>row.name==='*'&&row.q>0);
}
const compressible=type=>/^(?:application\/(?:json|javascript)|text\/(?:html|css|javascript))(?:\s*;|$)/i.test(String(type||''));
export function relayHttpResponse(req,res,response,headers){
  const status=response.statusCode||502,representation=compressible(headers['content-type'])&&!headers['content-encoding'],eligible=status===200&&representation;
  if(representation&&[200,304].includes(status)){headers.vary=[...new Set(String(headers.vary||'').split(',').map(x=>x.trim()).filter(Boolean).concat('Accept-Encoding'))].join(', ');if(headers.etag&&!headers.etag.startsWith('W/'))headers.etag='W/'+headers.etag;}
  if(status===304||req.method==='HEAD'){
    // A gzip GET's size is unknown without a body. HEAD may omit that field;
    // never claim its identity byte length for an encoding-varying response.
    if(status===304||eligible&&acceptsGzip(req.headers['accept-encoding'])&&(!headers['content-length']||Number(headers['content-length'])>1024))delete headers['content-length'];
    res.writeHead(status,headers);res.end();response.resume();return;
  }
  const length=Number(headers['content-length']);
  if(!eligible||!acceptsGzip(req.headers['accept-encoding'])||length>COMPRESSION_BODY_LIMIT||length>0&&length<=1024){res.writeHead(status,headers);response.pipe(res);return;}
  const chunks=[];let size=0,streamed=false;
  response.on('data',collect);
  function collect(chunk){
    size+=chunk.length;
    if(size>COMPRESSION_BODY_LIMIT){
      streamed=true;response.off('data',collect);res.writeHead(status,headers);
      for(const prior of chunks)res.write(prior);chunks.length=0;res.write(chunk);response.pipe(res);return;
    }
    chunks.push(chunk);
  }
  response.once('end',()=>{
    if(streamed||res.destroyed)return;
    const body=Buffer.concat(chunks);chunks.length=0;
    if(size<=1024){headers['content-length']=String(body.length);res.writeHead(status,headers);res.end(body);return;}
    gzip(body,{level:6},(error,compressed)=>{
      if(res.destroyed)return;
      const output=error||compressed.length>=body.length?body:compressed;
      if(output===compressed)headers['content-encoding']='gzip';
      headers['content-length']=String(output.length);res.writeHead(status,headers);res.end(output);
    });
  });
}
