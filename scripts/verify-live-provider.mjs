import {config as dotenv} from 'dotenv';import {createApp} from '../dist/app.js';
dotenv({quiet:true});const app=createApp();const results=[];
const check=async(name,fn)=>{try{const result=await fn();results.push({check:name,status:'PASS',...result});return result;}catch(e){results.push({check:name,status:'UNAVAILABLE',code:e.code??'error',message:e.message});}};
try{
 const scope=await app.bridge.request({type:'canvas-get',path:'/api/v1/courses?enrollment_state=active&state%5B%5D=available&per_page=100'});
 if(!Array.isArray(scope.body)||scope.body.length===0)throw new Error('No current courses');
 const courseId=String(scope.body[0].id);
 let assignments=[];let modules=[];let pages=[];let files=[];
 await check('current_courses',async()=>({count:scope.body.length,courses:scope.body.map(c=>({id:String(c.id),title:c.name}))}));
 await check('assignments',async()=>{assignments=await app.provider.collection('assignments',courseId);return {course_id:courseId,count:assignments.length,examples:assignments.slice(0,3).map(a=>({id:a.id,title:a.title,due_at:a.data.due_at,source:a.data.source}))};});
 if(assignments[0]){
  await check('assignment_detail',async()=>{const a=await app.provider.assignment(courseId,assignments[0].id);return {id:a.id,instruction_characters:String(a.data.description??'').length,has_rubric:Array.isArray(a.data.rubric),source:a.data.source};});
  await check('submission',async()=>{const s=await app.provider.submission(courseId,assignments[0].id);return {id:s.id,workflow_state:s.data.workflow_state,source:s.data.source};});
 }
 await check('modules',async()=>{modules=await app.provider.collection('modules',courseId);return {count:modules.length};});
 if(modules[0])await check('module_items',async()=>({module_id:modules[0].id,count:(await app.provider.moduleItems(courseId,modules[0].id)).length}));
 await check('enrollments_grades',async()=>{const entries=await app.provider.collection('enrollments',courseId);return {count:entries.length,grade_fields:entries.map(e=>Object.keys(e.data.grades??{})),source:entries[0]?.data.source};});
 await check('pages',async()=>{pages=await app.provider.collection('pages',courseId);return {count:pages.length};});
 if(pages[0])await check('page_body',async()=>{const p=await app.provider.page(courseId,pages[0].id);return {id:p.id,body_characters:String(p.data.body??'').length,source:p.data.source};});
 await check('files',async()=>{files=await app.provider.collection('files',courseId);return {count:files.length};});
 const file=files.filter(f=>f.data.locked_for_user!==true&&typeof f.data.size==='number'&&f.data.size>0&&f.data.size<8*1024*1024).sort((a,b)=>a.data.size-b.data.size)[0];
 if(file&&app.provider.download)await check('file_download',async()=>{const d=await app.provider.download(file,8*1024*1024);return {file_id:file.id,bytes:d.bytes.byteLength,expected_metadata_bytes:file.data.size};});
 console.log(JSON.stringify({mode:'live browser session, no PAT',results},null,2));
}finally{app.close();}
