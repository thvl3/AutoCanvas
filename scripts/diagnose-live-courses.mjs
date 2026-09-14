import {config as dotenv} from 'dotenv';
import {loadConfig} from '../dist/config.js';import {bridgeSettings} from '../dist/app.js';import {BridgeClient} from '../dist/bridge/client.js';import {COURSES_QUERY} from '../dist/providers/graphql.js';
dotenv({quiet:true});const config=loadConfig(process.env);const bridge=new BridgeClient(bridgeSettings(config));
const profile=await bridge.request({type:'canvas-get',path:'/api/v1/users/self/profile'});
for(const currentOnly of [true,false]){
 const query=currentOnly?COURSES_QUERY:COURSES_QUERY.replace(', currentOnly: true','');
 const r=await bridge.request({type:'graphql-query',query,variables:{userId:String(profile.body.id),after:null}});
 const connection=r.body.data?.user?.enrollmentsConnection;
 console.log(JSON.stringify({source:currentOnly?'graphql-currentOnly':'graphql-unrestricted-self',errors:r.body.errors?.map(e=>e.message),pageInfo:connection?.pageInfo,enrollments:connection?.nodes?.map(e=>({id:e._id,state:e.state,enrollmentState:e.enrollmentState,course:{id:e.course?._id,name:e.course?.name,state:e.course?.state,term:e.course?.term}}))},null,2));
}
const r=await bridge.request({type:'canvas-get',path:'/api/v1/courses?enrollment_state=active&state%5B%5D=available&per_page=100'});
console.log(JSON.stringify({source:'session-get-active-available',status:r.status,link:r.link,courses:Array.isArray(r.body)?r.body.map(c=>({id:c.id,name:c.name,workflow_state:c.workflow_state,term:c.term})):r.body},null,2));
