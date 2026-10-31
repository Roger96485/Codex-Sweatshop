import test from 'node:test';
import assert from 'node:assert/strict';
import {elicitationFields,elicitationResponse,elicitationUrl} from '../public/elicitation.mjs';

const params={mode:'form',requestedSchema:{type:'object',required:['name','enabled','count','choice','tags'],properties:{
  name:{type:'string',minLength:2,maxLength:8},enabled:{type:'boolean'},count:{type:'integer',minimum:1,maximum:4},
  choice:{type:'string',oneOf:[{const:'a',title:'Choice A'},{const:'b',title:'Choice B'}]},
  tags:{type:'array',items:{type:'string',enum:['x','y']},minItems:1,maxItems:2},
}}};
const content={name:'Joe',enabled:false,count:2,choice:'a',tags:['x']};

test('MCP forms preserve typed values and titled single/multiple choices',()=>{
  assert.equal(elicitationFields(params)[3].options[0].label,'Choice A');
  assert.deepEqual(elicitationResponse(params,{action:'accept',content}),{action:'accept',content});
  for(const action of ['decline','cancel'])assert.deepEqual(elicitationResponse(params,{action,content}),{action,content:null});
});
test('MCP form responses reject missing, invalid, out-of-range and unrequested values',()=>{
  for(const update of [{count:2.5},{count:9},{name:'x'},{enabled:'true'},{choice:'bad'},{tags:[]},{tags:['x','x']},{extra:'no'}])
    assert.throws(()=>elicitationResponse(params,{action:'accept',content:{...content,...update}}));
  assert.throws(()=>elicitationResponse(params,{action:'accept',content:{}}));
  assert.throws(()=>elicitationResponse(params,{action:'approve',content}));
});
test('URL elicitation permits web flows only and unsupported forms can still be declined',()=>{
  const request={mode:'url',url:'https://example.com/confirm'};
  assert.equal(elicitationUrl(request.url),request.url);
  assert.deepEqual(elicitationResponse(request,{action:'accept'}),{action:'accept',content:null});
  for(const url of ['file:///C:/test','javascript:alert(1)','https://user:password@example.com'])assert.throws(()=>elicitationUrl(url));
  const request2={mode:'openai/userVerification'};
  assert.throws(()=>elicitationResponse(request2,{action:'accept',content:{}}));
  assert.deepEqual(elicitationResponse(request2,{action:'cancel'}),{action:'cancel',content:null});
});
