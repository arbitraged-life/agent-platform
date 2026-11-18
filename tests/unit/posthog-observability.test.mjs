import test from 'node:test';
import assert from 'node:assert/strict';
import { turnEvent } from '../../runtime/observability/records.mjs';
import { createPosthogExporter, posthogOperationalRecord, validatePosthogConfig } from '../../runtime/observability/posthog.mjs';
import { evidenceRecord, validateObservabilityRecord } from '../../runtime/observability/evidence.mjs';

const timing={startedMs:1700000000000,endedMs:1700000001500};
const config={schema_version:1,endpoint:'https://example.invalid',credential_env:'POSTHOG_PROJECT_TOKEN',distinct_id:'personal-os-test'};
const fakeCredential=()=>['ghp',Date.now().toString(36).padEnd(24,'x')].join('_');
function trackedResponse(status, onCancel) {
  return new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode('private provider body')); },
    cancel: onCancel,
  }), {status});
}

test('PostHog operational record is privacy-safe and correlates to the Opik trace ID',()=>{
  const event=turnEvent({runtime:'omp',runId:'run',taskId:'task',agentId:'agent',modelId:'model',provider:'provider',...timing,
    toolCalls:2,toolFailures:1,usage:{input:7,output:9,total:16,costUsd:0.01}});
  const record=posthogOperationalRecord(event);
  assert.equal(record.event,'personal_os_agent_turn_completed');
  assert.equal(record.properties.event_id,event.event_id);
  assert.equal(record.properties.opik_trace_id,event.event_id);
  assert.equal(record.properties.duration_ms,1500);
  assert.equal(record.properties.tool_failures,1);
  assert.ok(!JSON.stringify(record).includes('prompt'));
});

test('PostHog exporter sends one fail-fast HTTPS capture request without leaking token into properties',async()=>{
  const event=turnEvent({runtime:'omp',runId:'run',...timing});
  const sent=[];
  const exporter=createPosthogExporter(config,{environment:{POSTHOG_PROJECT_TOKEN:'fixture-secret'},fetcher:async(url,options)=>{
    sent.push({url,options,body:JSON.parse(options.body)});
    return new Response('',{status:200});
  }});
  const result=await exporter(event);
  assert.equal(result.status,'delivered');
  assert.equal(sent.length,1);
  assert.equal(sent[0].url,'https://example.invalid/i/v0/e/');
  assert.equal(sent[0].body.api_key,'fixture-secret');
  assert.equal(sent[0].body.event,'personal_os_agent_turn_completed');
  assert.equal(sent[0].body.properties.opik_trace_id,event.event_id);
  assert.ok(!JSON.stringify(sent[0].body.properties).includes('fixture-secret'));
  assert.equal(sent[0].options.redirect,'error');
});

test('PostHog configuration rejects inline secrets and unsafe endpoints',()=>{
  const credentialUrl=new URL('https://example.invalid');credentialUrl.username='fixture';
  assert.throws(()=>validatePosthogConfig({...config,endpoint:credentialUrl.href}),/endpoint/);
  assert.throws(()=>validatePosthogConfig({...config,api_key:'inline-secret'}),/configuration/);
  assert.throws(()=>validatePosthogConfig({...config,schema_version:2}),/configuration/);
  assert.throws(()=>createPosthogExporter(config,{environment:{}}),/unavailable/);
});

test('PostHog exporter validates the canonical event before network activity',async()=>{
  let calls=0;
  const event=turnEvent({runtime:'omp',runId:'run',...timing});
  const exporter=createPosthogExporter(config,{environment:{POSTHOG_PROJECT_TOKEN:'fixture'},fetcher:async()=>{calls++;return new Response('');}});
  await assert.rejects(()=>exporter({...event,prompt:'private'}),/telemetry/);
  assert.equal(calls,0);
});

test('PostHog projection and exporter reject every credential-shaped completed-turn identifier',async()=>{
  const event=turnEvent({runtime:'omp',runId:'run',...timing}),credential=fakeCredential();
  let calls=0;
  const exporter=createPosthogExporter(config,{environment:{POSTHOG_PROJECT_TOKEN:'fixture'},fetcher:async()=>{calls++;return new Response('');}});
  for(const field of ['runtime','run_id','task_id','agent_id','model_id','provider']) {
    const unsafe={...event,[field]:credential};
    assert.throws(()=>posthogOperationalRecord(unsafe),/Sensitive telemetry identifier/);
    await assert.rejects(()=>exporter(unsafe),/Sensitive telemetry identifier/);
  }
  assert.equal(calls,0);
  assert.equal(posthogOperationalRecord(event).properties.run_id,'run');
  const bundle=validateObservabilityRecord({
    schema_version:1,record_type:'agent.trace',event_id:event.event_id,trace_id:event.event_id,records:[event],
  });
  assert.throws(()=>posthogOperationalRecord(bundle),/PostHog projection requires one record/);
});

test('PostHog discards unused success and HTTP rejection bodies without changing receipts',async()=>{
  const event=turnEvent({runtime:'omp',runId:'run',...timing});
  for(const status of [200,429,403]) {
    let cancellations=0,calls=0;
    const exporter=createPosthogExporter(config,{environment:{POSTHOG_PROJECT_TOKEN:'fixture'},fetcher:async()=>{
      calls++;return trackedResponse(status,()=>{cancellations++;});
    }});
    if(status===200) assert.equal((await exporter(event)).delivery_status,'accepted');
    else await assert.rejects(()=>exporter(event),error=>error.receipt.reason_code===`HTTP_${status}` &&
      error.receipt.retryable===(status===429) && error.receipt.delivery_status===(status===403?'denied':'failed'));
    assert.equal(calls,1);
    assert.equal(cancellations,1);
  }
});

test('PostHog ignores body cancellation failures while retaining HTTP classification',async()=>{
  const event=turnEvent({runtime:'omp',runId:'run',...timing});
  for(const status of [200,429,403]) {
    const exporter=createPosthogExporter(config,{environment:{POSTHOG_PROJECT_TOKEN:'fixture'},fetcher:async()=>trackedResponse(status,()=>{
      throw new Error('private provider body');
    })});
    if(status===200) assert.equal((await exporter(event)).delivery_status,'accepted');
    else await assert.rejects(()=>exporter(event),error=>error.receipt.reason_code===`HTTP_${status}` &&
      !error.message.includes('private provider body'));
  }
});

test('PostHog evidence metrics reject credential-shaped identifiers before transport',async()=>{
  const metrics=turnEvent({runtime:'omp',runId:'run',...timing});
  const envelope=evidenceRecord({eventName:'agent.turn.finished',traceId:metrics.event_id,runtime:'omp',runId:'run',
    observedMs:timing.startedMs,recordedMs:timing.startedMs,endedMs:timing.endedMs,outcome:'succeeded',metrics});
  let calls=0;
  const exporter=createPosthogExporter(config,{environment:{POSTHOG_PROJECT_TOKEN:'fixture'},fetcher:async()=>{
    calls++;return new Response(null,{status:200});
  }});
  assert.equal(posthogOperationalRecord(envelope).properties.evidence_event_id,envelope.event_id);
  assert.equal((await exporter(envelope)).delivery_status,'accepted');
  assert.equal(calls,1);
  const unsafe={...envelope,metrics:{...metrics,agent_id:fakeCredential()}};
  assert.throws(()=>posthogOperationalRecord(unsafe),/Sensitive telemetry identifier/);
  await assert.rejects(()=>exporter(unsafe),/Sensitive telemetry identifier/);
  assert.equal(calls,1);
});
