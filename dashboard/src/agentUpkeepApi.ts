import type { AgentUpkeepResult, AgentUpkeepStatus, UpkeepProvider } from "../../shared/agentUpkeep";
async function request<T>(url:string, init?:RequestInit):Promise<T> {
  const response = await fetch(url,init);
  if (!response.ok) throw new Error((await response.json().catch(()=>({}))).error ?? `HTTP ${response.status}`);
  return response.json();
}
export const agentUpkeepApi = {
  status:(provider:UpkeepProvider) => request<AgentUpkeepStatus>(`/api/agent-upkeep?provider=${provider}`),
  run:(provider:UpkeepProvider,session?:string) => request<AgentUpkeepResult>("/api/agent-upkeep/run",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({provider,session})}),
};
