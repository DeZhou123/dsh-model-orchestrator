import { createPeerAdapter } from '../src/peershare-adapter.js'
import { startPeerShareServer, lendableRows } from '../src/peershare.js'
const TOKEN='t'
const ROWS=[{provider:'raccoon',model:'sn-glm-5-3',modelName:'GLM',denied:false,tags:[]}]
const s = await startPeerShareServer({config:()=>({enabled:true,host:'127.0.0.1',port:0,token:TOKEN}),models:()=>lendableRows(ROWS,{}),stream:async function*(){yield {type:'finish',reason:{kind:'stop'}}},selfProvider:'peer'})
const b = createPeerAdapter({provider:'peer',config:()=>({peerUrl:'http://127.0.0.1:'+s.port,peerToken:TOKEN,timeoutMs:5000})})
const listed = await b.adapter.listModels('peer')
console.log('listed', JSON.stringify(listed))
console.log('error', JSON.stringify(b.modelsError))
await s.close()