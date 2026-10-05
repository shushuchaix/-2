// Page-memory credentials only. Never put these into store, URL or storage.
let temporaryKey='';
export const temporaryCredentials={set(value){temporaryKey=String(value||'');},get(){return temporaryKey?{userApiKey:temporaryKey}:{};},clear(){temporaryKey='';}};
