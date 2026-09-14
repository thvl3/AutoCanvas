import {it,expect} from 'vitest';
import {mkdtemp,rm} from 'node:fs/promises';import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';import {execFile} from 'node:child_process';import {promisify} from 'node:util';
it('supports auth status in tokenless default browser configuration',async()=>{
 const root=await mkdtemp(join(tmpdir(),'canvas-auth-cli-'));
 const env={...process.env,CANVAS_PROVIDER:'browser',CANVAS_BASE_URL:'https://byui.instructure.com',CANVAS_ACCESS_TOKEN:'',CANVAS_DB_PATH:join(root,'db.sqlite'),CANVAS_BRIDGE_STATE_DIR:join(root,'bridge'),LOG_LEVEL:'silent'};
 try{const {stdout}=await promisify(execFile)(process.execPath,['--import','tsx',resolve('src/cli/index.ts'),'auth','status'],{env,timeout:30000});expect(JSON.parse(stdout)).toMatchObject({provider:'browser-session',state:'bridge_disconnected'});}finally{await rm(root,{recursive:true,force:true});}
});
