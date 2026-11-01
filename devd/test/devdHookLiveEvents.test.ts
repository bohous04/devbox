import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const EMITTER = join(import.meta.dir,"../../image/vendor/devd-hooks/devd-hook.sh");
async function emit(event:string,input:object):Promise<Record<string,unknown> | null> {
  const dir=mkdtempSync(join(tmpdir(),"devd-live-hook-"));
  try {
    const fake=join(dir,"curl");
    writeFileSync(fake,'#!/bin/sh\nwhile [ "$#" -gt 0 ]; do\nif [ "$1" = "-d" ]; then shift; printf "%s" "$1" > "$CAPTURE"; fi\nshift\ndone\n');chmodSync(fake,0o755);
    const proc=Bun.spawn(["bash",EMITTER,event],{env:{...process.env,PATH:`${dir}:${process.env.PATH}`,CAPTURE:join(dir,"body.json"),DEVD_SESSION_ID:"session",DEVD_URL:"http://unreachable.invalid"},stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    proc.stdin.write(JSON.stringify(input));proc.stdin.end();expect(await proc.exited).toBe(0);
    return existsSync(join(dir,"body.json")) ? JSON.parse(readFileSync(join(dir,"body.json"),"utf8")) : null;
  } finally {rmSync(dir,{recursive:true,force:true});}
}

test("Claude/Codex/Grok tool metadata reaches hub without tool input or response content", async()=> {
  for (const payload of [
    {session_id:"main",tool_name:"AskUserQuestion",tool_use_id:"call",prompt_id:"turn",tool_input:{secret:"never transmit"}},
    {session_id:"main",tool_name:"functions.request_user_input",tool_call_id:"call",prompt_id:"turn",tool_response:{secret:"never transmit"}},
    {sessionId:"main",toolName:"ask_user_question",toolCallId:"call",promptId:"turn",input:{secret:"never transmit"}},
  ]) {
    const body=await emit("tool_complete",payload);
    expect(body).toMatchObject({event:"tool_complete",sessionId:"session",agentSessionId:"main",toolCallId:"call",promptId:"turn"});
    expect(body!.toolName).toBeTruthy();expect(JSON.stringify(body)).not.toContain("secret");
  }
});

test("Grok camelCase notification and permission tool identity are emitted",async()=> {
  expect(await emit("notification",{sessionId:"main",notificationType:"elicitation_response"})).toMatchObject({notificationType:"elicitation_response"});
  expect(await emit("permission_request",{sessionId:"main",toolName:"exec",toolUseId:"permission-1"})).toMatchObject({toolName:"exec",toolCallId:"permission-1"});
});

for (const tool_name of ["request_user_input_async", "functions.request_user_input_async"]) {
  test(`async question emits an input wait but no false answer: ${tool_name}`, async () => {
    const input = {session_id:"main", tool_name, tool_use_id:"question"};
    expect(await emit("tool_start", input)).toMatchObject({event:"tool_start", toolName:"request_user_input", toolCallId:"question"});
    expect(await emit("tool_complete", input)).toBeNull();
  });
}

test("question tools send the question text on tool_start; other tools never send input", async () => {
  expect(await emit("tool_start",{session_id:"main",tool_name:"AskUserQuestion",tool_use_id:"q",tool_input:{questions:[{question:"Which option?",header:"h",options:[{label:"secret-option"}]}]}}))
    .toMatchObject({toolName:"AskUserQuestion",question:"Which option?"});
  expect(await emit("tool_start",{session_id:"main",tool_name:"functions.request_user_input",tool_call_id:"q",tool_input:{questions:[{id:"a",question:"Continue?"}]}}))
    .toMatchObject({question:"Continue?"});
  expect(await emit("tool_start",{sessionId:"main",toolName:"ask_user",toolCallId:"q",input:{question:"Grok asks"}}))
    .toMatchObject({question:"Grok asks"});
  const long=await emit("tool_start",{session_id:"main",tool_name:"AskUserQuestion",tool_input:{question:"y".repeat(2000)}});
  expect((long!.question as string).length).toBeLessThanOrEqual(300);
  const other=await emit("tool_start",{session_id:"main",tool_name:"Bash",tool_input:{question:"secret",command:"secret"}});
  expect(JSON.stringify(other)).not.toContain("secret");
  const done=await emit("tool_complete",{session_id:"main",tool_name:"AskUserQuestion",tool_input:{question:"secret"}});
  expect(JSON.stringify(done)).not.toContain("secret");
});
