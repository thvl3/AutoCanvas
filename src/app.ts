import { resolve } from "node:path";
import { loadConfig, type Config } from "./config.js";
import { createLogger } from "./logger.js";
import { Repository } from "./db/repository.js";
import { SyncService } from "./services/sync.js";
import { AcademicService } from "./services/academic.js";
import { demoFetch } from "./demo/fixtures.js";
import { MockCanvasProvider } from "./providers/mock.js";
import { LegacyPatProvider } from "./providers/legacy-pat.js";
import { BrowserSessionProvider } from "./providers/browser-session.js";
import type { CanvasDataProvider } from "./providers/types.js";
import { BridgeClient } from "./bridge/client.js";
import type { BridgeSettings } from "./bridge/protocol.js";
export function bridgeSettings(config: Config): BridgeSettings {
 return {origin:config.baseUrl,host:config.bridgeHost??'127.0.0.1',port:config.bridgePort??47821,stateDir:config.bridgeStateDir??resolve('data/bridge'),timeoutMs:config.timeoutMs};
}
export function createApp(env: NodeJS.ProcessEnv = process.env, demo = false, dependencies:{provider?:CanvasDataProvider}={}) {
 const mock=demo||env.CANVAS_PROVIDER==='mock';
 const settings=mock?{...env,CANVAS_PROVIDER:'mock',CANVAS_BASE_URL:'https://canvas.example.invalid',CANVAS_DB_PATH:env.CANVAS_DB_PATH??resolve('data/demo.sqlite'),CANVAS_WORKSPACE_ROOT:env.CANVAS_WORKSPACE_ROOT??resolve('workspaces/demo')}:env;
 const config=loadConfig(settings);const logger=createLogger(config.logLevel);
 const bridge=new BridgeClient(bridgeSettings(config));
 const provider:CanvasDataProvider=dependencies.provider??(mock?new MockCanvasProvider(config):config.provider==='legacy-pat'?new LegacyPatProvider(config,{logger}):new BrowserSessionProvider(config,bridge,logger));
 const repo=new Repository(config.dbPath,config.baseUrl);
 const sync=new SyncService(repo,provider,{concurrency:config.syncConcurrency,logger,origin:config.baseUrl});
 const service=new AcademicService(repo,{config,provider,sync,...(mock?{downloadFetch:demoFetch}:config.provider==='legacy-pat'?{}:{acquireFile:async(file,maxBytes)=>{
  if(!provider.download)throw new Error('Selected provider does not support file acquisition.');
  return provider.download(file,maxBytes);
 }})});
 logger.debug({provider:mock?'mock':config.provider},'Canvas provider selected');
 return {config,logger,provider,api:provider,bridge,repo,service,close:()=>repo.close()};
}
