// Development-only browser harness; uses invented text, never contacts the website.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const bootstrap = `
let uiState;let auth={status:'loggedOut'};
const book={id:1,title:'测试作品'};
const chapters=[{id:2,title:'序章 · 一个安静的下午',volume:'第一卷',url:''},{id:3,title:'第一章 · 新的旅途',volume:'第一卷',url:''},{id:4,title:'序章',volume:'第二卷',url:''}];
let chapter=chapters[0];let hidden=false;
const paragraphs=Array.from({length:100},(_,i)=>i===1?'<script>alert("unsafe")</script>':i%3===0?'窗外的风轻轻拂过树梢，光影在书页上缓慢地移动。':i%3===1?'「今天的故事，就从这里开始吧。」她合上笔记本，抬起头说。':'桌边的时钟滴答作响，远处传来电车经过的声音。');
const shelf=[{...book,chapterId:2,progress:0,updatedAt:Date.now()}];
function notify(m){window.dispatchEvent(new MessageEvent('message',{data:m}));}
function state(){notify({type:'state',shelf,hidden,auth,settings:{fontSize:14,lineHeight:1.9,showImages:false},current:{catalog:{book,chapters},chapter,content:{title:chapter.title,paragraphs,images:[]}}});}
window.__messages=[];
window.acquireVsCodeApi=()=>({getState:()=>uiState,setState:s=>uiState=s,postMessage:m=>{window.__messages.push(m.type==='login'?{type:m.type,username:m.username,hasPassword:!!m.password}:m);if(m.type==='login'){const failed=m.password==='wrong';auth={status:'loggingIn'};notify({type:'auth',auth});setTimeout(()=>{auth=failed?{status:'loggedOut'}:{status:'loggedIn',username:m.username};notify({type:'auth',auth});if(failed)notify({type:'error',authError:true,code:'credentials',message:'登录失败，请检查账号或密码。'});else state();},30);}if(m.type==='logout'){auth={status:'loggedOut'};state();notify({type:'notice',message:'已退出登录。'});}if(m.type==='verify')notify({type:'notice',message:'测试环境：模拟网站验证。'});if(m.type==='verified'){auth={status:'loggedOut'};notify({type:'auth',auth});notify({type:'verificationComplete',loggedIn:false});}if(m.type==='ready')setTimeout(state,10);if(m.type==='hide'||m.type==='resume'){hidden=m.type==='hide';notify({type:'hidden',hidden});}if(m.type==='progress')shelf[0].progress=m.value;if(m.type==='chapter'){chapter=chapters.find(c=>c.id===m.id);shelf[0].progress=0;state();}if(m.type==='step'){const i=chapters.indexOf(chapter);chapter=chapters[i+m.delta]||chapter;shelf[0].progress=0;state();}if(m.type==='home')notify({type:'state',shelf,hidden:false,auth,settings:{fontSize:14}});if(m.type==='open')state();}});
`;
const themes = `:root{--vscode-editor-background:#1e1e1e;--vscode-editor-foreground:#d4d4d4;--vscode-editor-font-family:Menlo,monospace;--vscode-editor-font-size:14px;--vscode-descriptionForeground:#888;--vscode-debugTokenExpression-string:#ce9178;--vscode-textLink-foreground:#569cd6;--vscode-sideBar-background:#181818;--vscode-panel-border:#333;--vscode-input-background:#313131;--vscode-input-foreground:#ccc;--vscode-foreground:#ccc;}`;
const server=http.createServer((req,res)=>{
 if(req.url==='/'){res.setHeader('content-type','text/html');res.end('<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'self\'; script-src \'self\';"><link rel="stylesheet" href="/theme.css"><link rel="stylesheet" href="/reader.css"><div id="app"></div><script src="/bootstrap.js"></script><script src="/reader.js"></script></html>');return;}
 if(req.url==='/bootstrap.js'){res.setHeader('content-type','application/javascript');res.end(bootstrap);return;}
 if(req.url==='/theme.css'){res.setHeader('content-type','text/css');res.end(themes);return;}
 const name={'/reader.css':'reader.css','/reader.js':'reader.js'}[req.url];
 if(name){res.setHeader('content-type',name.endsWith('css')?'text/css':'application/javascript');res.end(fs.readFileSync(path.join(root,'media',name)));return;}
 res.statusCode=404;res.end();
});
server.listen(4178,'127.0.0.1',()=>console.log('Reader preview: http://127.0.0.1:4178'));
