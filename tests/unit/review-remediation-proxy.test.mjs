import test from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {createInferenceProxy} from '../../runtime/review-remediation/inference-proxy.mjs';

test('inference proxy confines credentials, model, endpoint and request budget',async()=>{
  const calls=[];
  const server=createInferenceProxy({endpoint:'https://openrouter.ai/api/v1/chat/completions',model:'qwen/qwen3-coder',
    key:'upstream-test-key',token:'run-test-token',maxRequests:2,maxOutputTokens:4096},async(url,options)=>{
      calls.push({url,options});return Response.json({choices:[{message:{role:'assistant',content:'ok'}}]});
    });
  server.listen(0,'127.0.0.1');await once(server,'listening');
  const base=`http://127.0.0.1:${server.address().port}`;
  const send=(path,body,token='run-test-token')=>fetch(base+path,{method:'POST',headers:{Authorization:`Bearer ${token}`},body:JSON.stringify(body)});
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
    const response=await fetch(`http://127.0.0.1:${server.address().port}/v1/chat/completions`,{method:'POST',headers:{Authorization:'Bearer run'},body:JSON.stringify({model:'m',messages:[]})});
    assert.equal(response.status,502);assert.ok(!(await response.text()).includes('secret-test'));
  } finally {server.closeAllConnections();server.close();}
});
