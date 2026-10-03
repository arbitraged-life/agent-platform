import test from 'node:test';
import assert from 'node:assert/strict';
import { turnEvent } from '../../runtime/observability/records.mjs';
import { createPosthogExporter, posthogOperationalRecord, validatePosthogConfig } from '../../runtime/observability/posthog.mjs';

const timing={startedMs:1700000000000,endedMs:1700000001500};
const config={schema_version:1,endpoint:'https://example.invalid',credential_env:'POSTHOG_PROJECT_TOKEN',distinct_id:'personal-os-test'};

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
