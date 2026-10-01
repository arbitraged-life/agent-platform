import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createInferenceProxy} from '../../runtime/review-remediation/inference-proxy.mjs';

test('inference proxy confines credentials, model, endpoint and request budget',async()=>{
  const calls=[];
  const server=createInferenceProxy({endpoint:'https://openrouter.ai/api/v1/chat/completions',model:'qwen/qwen3-coder',
    key:'upstream-test-key',token:'run-test-token',maxRequests:3,maxOutputTokens:4096},async(url,options)=>{
      calls.push({url,options});return Response.json({choices:[{message:{role:'assistant',content:'ok'}}]});
    });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=(path,body,token='run-test-token')=>fetch(base+path,{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
  try {
    assert.equal((await send('/v1/chat/completions',{},'wrong')).status,401);
    assert.equal((await send('/arbitrary',{model:'qwen/qwen3-coder'})).status,404);
    assert.equal((await send('/v1/chat/completions',{model:'different'})).status,400);
    const first=await send('/v1/chat/completions',{model:'qwen/qwen3-coder',messages:[{role:'user',content:'fix'}],max_tokens:999999,endpoint:'https://evil.invalid'});
    assert.equal(first.status,200);assert.ok(!(await first.text()).includes('upstream-test-key'));
    assert.equal(calls[0].url,'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(calls[0].options.headers.Authorization,'Bearer upstream-test-key');
    const forwarded=JSON.parse(calls[0].options.body);
    assert.equal(forwarded.max_tokens,4096);assert.equal(forwarded.endpoint,undefined);
    assert.equal((await send('/v1/chat/completions',{model:'qwen/qwen3-coder',messages:[]})).status,200);
    assert.equal((await send('/v1/chat/completions',{model:'qwen/qwen3-coder',messages:[]})).status,429);
    assert.equal(calls.length,2);
  } finally {server.closeAllConnections();server.close();}
});
test('upstream failures do not echo credentials or response bodies',async()=>{
  const server=createInferenceProxy({endpoint:'https://openrouter.ai/api/v1/chat/completions',model:'m',key:'secret-test',token:'run',maxRequests:1,maxOutputTokens:100},
    async()=>new Response('provider error: secret-test',{status:401}));
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer run'},body:JSON.stringify({model:'m',messages:[]})});
    assert.equal(response.status,502);assert.ok(!(await response.text()).includes('secret-test'));
  } finally {server.closeAllConnections();server.close();}
});

test('authenticated incomplete bodies reserve the bounded request budget',async()=>{
  const {request}=await import('node:http');
  let called=0;
  const server=createInferenceProxy({endpoint:'https://example.invalid/inference',model:'m',key:'key',token:'run',maxRequests:1,maxOutputTokens:100},async()=>{called++;return Response.json({});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const accepted=once(server,'request');
  const pending=request(base+'/v1/chat/completions',{method:'POST',headers:{Authorization:'Bearer run'}});
  pending.on('error',()=>{});pending.write('{');
  try {
    await accepted;
    const response=await fetch(base+'/v1/chat/completions',{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer run'},body:'{}'});
    assert.equal(response.status,429);assert.equal(called,0);
  } finally {pending.destroy();server.closeAllConnections();server.close();}
});

test('invalid request bodies return 400 and a missing model fails startup',async()=>{
  const config={endpoint:'https://example.invalid/inference',model:'m',key:'key',token:'run',maxRequests:3,maxOutputTokens:100};
  assert.throws(()=>createInferenceProxy({...config,model:undefined}),/configuration/);
  const server=createInferenceProxy(config,async()=>{throw new Error('must not reach upstream');});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  try {
    for(const body of ['null','[1]','{']) {
      const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',signal:AbortSignal.timeout(5000),headers:{Authorization:'Bearer run'},body});
      assert.equal(response.status,400);
    }
  } finally {server.closeAllConnections();server.close();}
});

test('request decoding preserves split UTF-8 and rejects invalid UTF-8',async()=>{
  const {request}=await import('node:http');
  const calls=[];
  const server=createInferenceProxy({endpoint:'https://example.invalid/inference',model:'m',key:'key',token:'run',maxRequests:3,maxOutputTokens:100},
    async(url,options)=>{calls.push(JSON.parse(options.body));return Response.json({});});
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const send=async(first,last)=>{
    const pending=request(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{Authorization:'Bearer run'}});
    const result=new Promise((resolve,reject)=>{
      pending.on('error',reject);
      pending.on('response',res=>{res.resume();res.on('end',()=>resolve(res.statusCode));});
    });
    pending.setTimeout(5000,()=>pending.destroy(new Error('fragmented request timed out')));
    // Send the continuation only after the server observes the first chunk.
    server.once('request',incoming=>incoming.once('data',()=>pending.end(last)));
    pending.write(first);
    return result;
  };
  try {
    const body=Buffer.from(JSON.stringify({model:'m',messages:[{role:'user',content:'café 🧪'}]}));
    const offset=body.indexOf(Buffer.from('é'))+1;
    assert.equal(await send(body.subarray(0,offset),body.subarray(offset)),200);
    assert.equal(calls[0].messages[0].content,'café 🧪');
    assert.equal(await send(Buffer.from('{"model":"m","messages":["'),Buffer.from([0xff,34,93,125])),400);
    assert.equal(calls.length,1);
  } finally {server.closeAllConnections();server.close();}
});
