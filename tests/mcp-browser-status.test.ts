import {it,expect} from 'vitest';
import {Client,InMemoryTransport} from '@modelcontextprotocol/client';
import {createServer} from '../src/mcp/server.js';import {AcademicService} from '../src/services/academic.js';
it('reports provider health and actionable authentication errors without exposing the bridge',async()=>{
 const error=Object.assign(new Error('Open Canvas in your browser and sign in.'),{code:'canvas_authentication_required',retryable:true});
 const repo={list:()=>[],get:()=>undefined,syncState:()=>null,recentChanges:()=>[]};
 const service=new AcademicService(repo,{provider:{healthCheck:async()=>({provider:'browser-session',origin:'https://byui.instructure.com',state:'authentication_required'})},sync:{run:async()=>{throw error;}}});
 const server=createServer(service);const client=new Client({name:'session-test',version:'1'});const [a,b]=InMemoryTransport.createLinkedPair();await Promise.all([server.connect(a),client.connect(b)]);
 try{
  const health=await client.callTool({name:'canvas_auth_status',arguments:{}});expect(health.structuredContent).toMatchObject({ok:true,data:{state:'authentication_required'}});
  const result=await client.callTool({name:'canvas_sync',arguments:{}});expect(result.isError).toBe(true);expect(result.structuredContent).toMatchObject({ok:false,error:{code:'canvas_authentication_required',retryable:true,message:'Open Canvas in your browser and sign in.'}});
 }finally{await client.close();await server.close();}
});
