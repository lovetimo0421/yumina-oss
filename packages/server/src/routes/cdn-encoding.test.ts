import test from 'node:test';
import assert from 'node:assert/strict';
import {Readable} from 'node:stream';
import {gzipSync,gunzipSync} from 'node:zlib';
import {Hono} from 'hono';
process.env.BETTER_AUTH_SECRET='cdn-encoding-test-only';
process.env.DATABASE_URL='postgresql://test:test@127.0.0.1:1/test';
const {streamS3Object}=await import('./cdn.js');

test('compressed immutable packs preserve encoding, byte length and decoded progress size',async()=>{
 const original=Buffer.from('actual game resource\n'.repeat(1000)),compressed=gzipSync(original);
 const app=new Hono();
 app.get('/pack',c=>streamS3Object(c,'worlds/pvz-previews/'+'b'.repeat(64)+'/main.pak','fixture',async()=>({
  body:Readable.from([compressed]),contentType:'application/octet-stream',contentLength:compressed.length,
  contentRange:null,etag:'"compressed"',contentEncoding:'gzip',decodedLength:original.length,
 })));
 const response=await app.request('/pack');
 assert.equal(response.headers.get('content-encoding'),'gzip');
 assert.equal(response.headers.get('content-length'),String(compressed.length));
 assert.equal(response.headers.get('x-uncompressed-length'),String(original.length));
 assert.match(response.headers.get('access-control-expose-headers')??'',/X-Uncompressed-Length/);
 assert.match(response.headers.get('cache-control')??'',/immutable/);
 assert.deepEqual(gunzipSync(Buffer.from(await response.arrayBuffer())),original);
});

test('ordinary ranged media retains its unencoded range and short cache policy',async()=>{
 const app=new Hono();let received:unknown;
 app.get('/media',c=>streamS3Object(c,'users/test/audio.ogg','fixture',async(_key,opts)=>{
  received=opts;return {body:Readable.from([Buffer.from('abc')]),contentType:'audio/ogg',contentLength:3,contentRange:'bytes 2-4/10',etag:null};
 }));
 const response=await app.request('/media',{headers:{Range:'bytes=2-4'}});
 assert.deepEqual(received,{range:'bytes=2-4'});assert.equal(response.status,206);
 assert.equal(response.headers.get('content-encoding'),null);assert.equal(response.headers.get('x-uncompressed-length'),null);
 assert.equal(response.headers.get('content-range'),'bytes 2-4/10');assert.equal(await response.text(),'abc');
 assert.doesNotMatch(response.headers.get('cache-control')??'',/immutable/);
});
