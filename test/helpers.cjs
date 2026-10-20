const { WenkuClient } = require('../dist/client');
function secrets() {
 const entries=new Map();
 return {entries, async get(k){return entries.get(k);},async store(k,v){entries.set(k,v);},async delete(k){entries.delete(k);}};
}
function browser() {
 return {active:false,async openVerification(){this.active=true;},async request(){throw new Error('unexpected browser request');},async cancel(){},async clearCookies(){this.active=false;},dispose(){this.active=false;}};
}
function client(){return new WenkuClient(secrets(),browser());}
module.exports={secrets,browser,client};
