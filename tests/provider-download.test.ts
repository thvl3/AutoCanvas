import {it,expect} from 'vitest';
import {mkdtemp,rm,readFile,readdir} from 'node:fs/promises';import {join} from 'node:path';import {tmpdir} from 'node:os';
import {loadConfig} from '../src/config.js';import {downloadFile} from '../src/services/download.js';import {openSafeDirectory} from '../src/services/workspace.js';
import type {Entity} from '../src/domain/types.js';
it('writes browser-acquired bytes with existing safe filenames without any Canvas URL or token',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-provider-file-'));const directory=await openSafeDirectory(root);
 const config=loadConfig({CANVAS_BASE_URL:'https://byui.instructure.com',CANVAS_MAX_DOWNLOAD_BYTES:'4'});
 const file:Entity={id:'7',course_id:'1',kind:'files',title:'Reference',updated_at:null,data:{filename:'../../ref.txt'},raw:{}};
 try{
 const result=await downloadFile(file,directory,config,{acquire:async(received,limit)=>{expect(received.id).toBe('7');expect(limit).toBe(4);return {bytes:new Uint8Array([1,2,3])};},fetch:async()=>{throw new Error('Network must stay in browser');}});
 expect([...await readFile(join(root,result.path))]).toEqual([1,2,3]);expect(result.source).toBe('canvas-file:7');
 await expect(downloadFile(file,directory,config,{acquire:async()=>({bytes:new Uint8Array([4])})})).rejects.toThrow();
 file.id='8';await expect(downloadFile(file,directory,config,{acquire:async()=>({bytes:new Uint8Array(5)})})).rejects.toThrow(/limit/);
 expect(await readdir(root)).toEqual([result.path]);
 }finally{await directory.handle?.close();await rm(root,{recursive:true,force:true});}
});
