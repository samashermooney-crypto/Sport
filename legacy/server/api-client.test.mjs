import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import ts from "typescript";
const javascript=ts.transpileModule(readFileSync(new URL("../src/api.ts",import.meta.url),"utf8"),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;
const {api,ApiError}=await import(`data:text/javascript;base64,${Buffer.from(javascript).toString("base64")}`);
test("API failures preserve structured recovery details and never retry writes automatically",async()=>{
 const original=globalThis.fetch;
 try {
  let calls=0;
  globalThis.fetch=async()=>{calls++;throw new TypeError("network failure");};
  await assert.rejects(api("/example",{method:"POST"}),e=>e instanceof ApiError && e.status===0 && /check its result/.test(e.message));
  assert.equal(calls,1);
  globalThis.fetch=async()=>new Response("<html>Unavailable</html>",{status:502});
  await assert.rejects(api("/example"),e=>e.status===502 && /unreadable response/.test(e.message));
  globalThis.fetch=async()=>Response.json({error:"Price changed",transfer_not_saved:true},{status:409});
  await assert.rejects(api("/example"),e=>e.status===409 && e.message==="Price changed" && e.details.transfer_not_saved===true);
  globalThis.fetch=async()=>Response.json(null,{status:500});
  await assert.rejects(api("/example"),e=>e.status===500 && /Request failed/.test(e.message));
  globalThis.fetch=async()=>Response.json({ok:true});
  assert.deepEqual(await api("/example"),{ok:true});
  const controller=new AbortController();controller.abort();
  const aborted=new DOMException("Aborted","AbortError");
  globalThis.fetch=async()=>{throw aborted;};
  await assert.rejects(api("/example",{signal:controller.signal}),e=>e===aborted);
 } finally {globalThis.fetch=original;}
});
