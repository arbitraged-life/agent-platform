import test from 'node:test';
import assert from 'node:assert/strict';
import {turnEvent,normalizeUsage,openAgentEvent,ompEvent} from '../../observability/records.mjs';
import {createOpikExporter,validateOpikConfig} from '../../observability/opik.mjs';
const timing={startedMs:1700000000000,endedMs:1700000001500};
const config={schema_version:1,endpoint:'https://example.invalid/opik/api',workspace:'fixture',project:'fixture',credential_env:'OPIK_API_KEY'};

test('runtime adapters share units and preserve reported totals without inventing usage',()=>{
 const open=openAgentEvent({runtime:'opencode',sessionID:'run',assistant:{role:'assistant',time:{created:timing.startedMs,completed:timing.endedMs},tokens:{input:7,output:9,total:19,cache:{read:3}},cost:0}});
 const omp=ompEvent({event:{message:{usage:{input:7,output:9,totalTokens:19,cacheRead:3,cost:{total:0}}}},context:{sessionManager:{getSessionId:()=> 'run'}},...timing});
 assert.deepEqual(open.usage,omp.usage);assert.equal(open.duration_ms,1500);assert.equal(omp.duration_ms,1500);
 assert.equal(open.usage.cost_usd,0);assert.equal(open.usage.reasoning_tokens,null);
 assert.equal(normalizeUsage({input:7,output:9}).total_tokens,null);
 assert.equal(normalizeUsage({input:NaN,costUsd:-1}).input_tokens,null);
});

test('default structured events exclude private content and raw errors',()=>{
 const event=openAgentEvent({runtime:'kilo',sessionID:'run',prompt:'PRIVATE_PROMPT',assistantText:'PRIVATE_OUTPUT',assistant:{role:'assistant',time:{created:timing.startedMs,completed:timing.endedMs},path:{cwd:'PRIVATE_PATH'},error:{message:'PRIVATE_TOKEN'},tokens:{}},tools:{calls:1,errors:1,names:{PRIVATE_COMMAND:1}}});
 assert.equal(event.status,'failed');assert.equal(event.tool_failures,1);
 assert.ok(!JSON.stringify(event).includes('PRIVATE_'));
 assert.throws(()=>turnEvent({runtime:'omp',runId:'run',...timing,toolCalls:0,toolFailures:1}),/tool counts/);
});

test('exporter shares trace/span identity and does not echo failed provider payloads',async()=>{
 const sent=[],event=turnEvent({runtime:'omp',runId:'run',...timing});
 const exporter=createOpikExporter(config,{environment:{OPIK_API_KEY:'fixture-credential'},fetcher:async(url,options)=>{sent.push({url,options,body:JSON.parse(options.body)});return new Response('',{status:201});}});
 assert.equal((await exporter(event)).status,'delivered');assert.equal(sent.length,2);
 assert.equal(sent[1].body.trace_id,sent[0].body.id);assert.equal(sent[1].body.usage,undefined);
 assert.ok(!JSON.stringify(sent.map(row=>row.body)).includes('fixture-credential'));
 assert.equal(sent[0].options.redirect,'error');assert.ok(sent[0].options.signal);
 for(const fetcher of [async()=>new Response('fixture-credential',{status:500}),async()=>{throw new Error('fixture-credential');}]) {
  const fail=createOpikExporter(config,{environment:{OPIK_API_KEY:'fixture-credential'},fetcher});
  await assert.rejects(()=>fail(event),error=>!error.message.includes('fixture-credential'));
 }
});

test('configuration is explicit, versioned and rejects credential-bearing destinations',()=>{
 const credentialUrl=new URL('https://example.invalid');credentialUrl.username='fixture';credentialUrl.password='fixture';
 assert.throws(()=>validateOpikConfig({...config,endpoint:credentialUrl.href}),/endpoint/);
 assert.throws(()=>validateOpikConfig({...config,api_key:'inline-secret'}),/configuration/);
 assert.throws(()=>validateOpikConfig({...config,schema_version:2}),/configuration/);
 assert.throws(()=>createOpikExporter(config,{environment:{}}),/unavailable/);
});

test('export rejects arbitrary metadata and invalid usage before network activity',async()=>{
 const event=turnEvent({runtime:'omp',runId:'run',...timing});
 let calls=0;
 const exporter=createOpikExporter(config,{environment:{OPIK_API_KEY:'fixture'},fetcher:async()=>{calls++;return new Response('');}});
 for(const invalid of [{...event,prompt:'private'},{...event,usage:{...event.usage,total_tokens:-1}},{...event,usage:{...event.usage,raw:'private'}},{...event,duration_ms:1},{...event,event_id:'not-a-uuid'}])
  await assert.rejects(()=>exporter(invalid),/telemetry/);
 assert.equal(calls,0);
});

test('export snapshot cannot acquire private content during an awaited request',async()=>{
 const event=turnEvent({runtime:'omp',runId:'run',...timing}),id=event.event_id,sent=[];
 const exporter=createOpikExporter(config,{environment:{OPIK_API_KEY:'fixture'},fetcher:async(_url,options)=>{
  sent.push(JSON.parse(options.body));event.prompt='PRIVATE_MUTATION';event.usage.raw='PRIVATE_USAGE';event.event_id='mutated';return new Response('');
 }});
 assert.equal((await exporter(event)).event_id,id);
 assert.equal(sent.length,2);assert.ok(!JSON.stringify(sent).includes('PRIVATE_'));
});

test('required event values cannot be replaced by constructor defaults during validation',async()=>{
 const event=turnEvent({runtime:'omp',runId:'run',...timing});let calls=0;
 const exporter=createOpikExporter(config,{environment:{OPIK_API_KEY:'fixture'},fetcher:async()=>{calls++;return new Response('');}});
 for(const field of ['event_id','status','attempt','tool_calls','tool_failures'])
  for(const value of [null,undefined])await assert.rejects(()=>exporter({...event,[field]:value}));
 assert.equal(calls,0);
});

test('external runtime error marks the turn failed without exporting the error',()=>{
 const event=openAgentEvent({runtime:'kilo',sessionID:'run',error:{message:'PRIVATE_ERROR'},assistant:{role:'assistant',time:{created:timing.startedMs,completed:timing.endedMs}}});
 assert.equal(event.status,'failed');assert.ok(!JSON.stringify(event).includes('PRIVATE_ERROR'));
});
