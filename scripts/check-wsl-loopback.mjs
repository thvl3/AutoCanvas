import {createServer} from 'node:http';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const server=createServer((_req,res)=>{res.setHeader('Content-Type','text/plain; charset=utf-8');res.end('autocanvas-loopback-ok');});
await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
try{
 const port=server.address().port;
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',`(Invoke-WebRequest -UseBasicParsing -TimeoutSec 10 http://127.0.0.1:${port}/).Content`],{timeout:20000});
 if(stdout.trim()!=='autocanvas-loopback-ok')throw new Error('Unexpected loopback response: '+JSON.stringify(stdout));
 console.log('PASS: Windows can reach a WSL service bound only to 127.0.0.1.');
}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
