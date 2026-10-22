const { test } = require('node:test');
const assert = require('node:assert/strict');
const Module = require('node:module');
const originalLoad = Module._load;
Module._load = function(name,...rest) { if(name==='vscode') return {}; return originalLoad.call(this,name,...rest); };
const { NativeSession } = require('../dist/session');
Module._load = originalLoad;
test('native GET and login POST expressions are syntactically valid, single requests and strict URLs', async () => {
  const native = new NativeSession(); native.ready = true;
  const expressions = [];
  native.cdp = { send: async (method, params) => {
    assert.equal(method,'Runtime.evaluate');
    new Function(`return ${params.expression}`);
    expressions.push(params.expression);
    return { result:{value:{url:'https://www.wenku8.net/index.php',status:200,html:'ok'}} };
  } };
  await native.page('https://www.wenku8.net/book/1.htm');
  await native.page('https://www.wenku8.net/login.php?do=submit',{body:'password=fixture'});
  assert.equal(expressions.length,2);
  assert.equal((expressions[1].match(/await fetch\(/g)||[]).length,1);
  await assert.rejects(native.page('https://evil.com/'), /拒绝/);
  assert.equal(expressions.length,2);
});
