import {createServer} from 'node:http';
import {timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';

/** This server has no workspace mount and forwards to one trusted HTTPS endpoint. */
export function createInferenceProxy(config, fetcher=fetch) {
  if (new URL(config.endpoint).protocol!=='https:' || !config.key || !config.token ||
      !Number.isInteger(config.maxRequests) || config.maxRequests<1 || config.maxRequests>12 ||
      !Number.isInteger(config.maxOutputTokens) || config.maxOutputTokens<1 || config.maxOutputTokens>4096)
    throw new Error('Invalid inference proxy configuration');
  let requests=0;
  const expected=Buffer.from(`Bearer ${config.token}`);
  return createServer(async(req,res)=>{
    const fail=(status,message)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify({error:message}));};
    if(req.method==='GET' && req.url==='/health') {res.end('ok');return;}
    const supplied=Buffer.from(req.headers.authorization??'');
    if(supplied.length!==expected.length || !timingSafeEqual(supplied,expected)) {fail(401,'Unauthorized');return;}
    if(req.method!=='POST' || req.url!=='/v1/chat/completions') {fail(404,'Unsupported endpoint');return;}
    try {
      let text='';
      for await(const chunk of req) {
        text+=chunk.toString('utf8');
        if(Buffer.byteLength(text)>262144) {fail(413,'Request too large');return;}
      }
      const body=JSON.parse(text);
      if(body.model!==config.model || !Array.isArray(body.messages)) {fail(400,'Unsupported model or messages');return;}
      if(requests>=config.maxRequests) {fail(429,'Attempt inference budget exhausted');return;}
      requests++;
      const allowed=['messages','tools','tool_choice','parallel_tool_calls','temperature','top_p','stream','stream_options'];
      const forwarded=Object.fromEntries(allowed.filter(k=>body[k]!==undefined).map(k=>[k,body[k]]));
      forwarded.model=config.model;
      forwarded.max_tokens=Math.min(config.maxOutputTokens,Number.isInteger(body.max_tokens)&&body.max_tokens>0?body.max_tokens:config.maxOutputTokens);
      const response=await fetcher(config.endpoint,{method:'POST',redirect:'error',
        headers:{Authorization:`Bearer ${config.key}`,'Content-Type':'application/json'},
        body:JSON.stringify(forwarded),signal:AbortSignal.timeout(90000)});
      if(!response.ok) {fail(502,`Inference upstream rejected request (${response.status})`);return;}
      res.writeHead(200,{'Content-Type':body.stream?'text/event-stream':'application/json'});
      let bytes=0;
      for await(const chunk of response.body) {
        bytes+=chunk.length;
        if(bytes>4*1024*1024) {res.destroy();return;}
        res.write(chunk);
      }
      res.end();
    } catch {
      if(!res.headersSent) fail(502,'Inference request failed');
      else res.destroy();
    }
  });
}

if(process.argv[1] && import.meta.url===pathToFileURL(process.argv[1]).href) {
  const server=createInferenceProxy({endpoint:process.env.INFERENCE_ENDPOINT,model:process.env.INFERENCE_MODEL,
    key:process.env.INFERENCE_API_KEY,token:process.env.INFERENCE_PROXY_TOKEN,
    maxRequests:Number(process.env.INFERENCE_MAX_REQUESTS),maxOutputTokens:Number(process.env.INFERENCE_MAX_OUTPUT_TOKENS)});
  server.requestTimeout=120000;
  server.listen(8080,'0.0.0.0');
}
