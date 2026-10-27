import { verifyCollectionRuntime } from '../infrastructure/collection/runtime.mjs';

/** Optional capability verification is single-flight and never blocks base startup. */
export function createCollectionRuntimeManager({runtime,root,verify=verifyCollectionRuntime,onStage=()=>{}}={}){
  let current=runtime||{available:false,verified:false,capabilities:{static:false,dynamic:false,enhanced:false}},pending;
  const manager={
    get verified(){return current.verified===true;},
    get capabilities(){return structuredClone(current.capabilities||{static:false,dynamic:false,enhanced:false});},
    get available(){return current.verified===true&&current.available!==false;},
    get root(){return current.root;},get python(){return current.python;},get workerPath(){return current.workerPath;},
    get issues(){return structuredClone(current.issues||[]);},
    async ensureReady(){
      if(current.verified||!root)return manager.snapshot();
      if(!pending)pending=(async()=>{
        onStage({stage:'optional-runtime-verifying'});
        try{current=await verify({root});onStage({stage:current.verified?'optional-runtime-ready':'optional-runtime-unavailable'});return manager.snapshot();}
        finally{pending=null;}
      })();return pending;
    },
    snapshot(){return {available:manager.available,verified:manager.verified,capabilities:manager.capabilities,issues:manager.issues};},
  };
  return Object.freeze(manager);
}
