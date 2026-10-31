// Shared by the request UI and runner so displayed forms and accepted replies agree.
export function elicitationUrl(value) {
  const url=new URL(value);
  if(!['https:','http:'].includes(url.protocol)||url.username||url.password)throw new Error('This request does not contain a supported web URL.');
  return url.href;
}

export function elicitationFields(params) {
  if(!['form','openai/form','openaiForm'].includes(params.mode))throw new Error('This request must be completed in Codex Desktop.');
  const schema=params.requestedSchema;
  if(schema?.type!=='object'||!schema.properties||Array.isArray(schema.properties))throw new Error('The requested form is not supported.');
  return Object.entries(schema.properties).map(([name,field])=>{
    if(!field||!['string','number','integer','boolean','array'].includes(field.type))throw new Error('The requested form contains an unsupported field.');
    const choices=field.type==='array'?field.items:field;
    const options=Array.isArray(choices?.enum)?choices.enum.map((value,index)=>({value,label:choices.enumNames?.[index]??value}))
      :(choices?.oneOf??choices?.anyOf)?.map(option=>({value:option.const,label:option.title??option.const}));
    if(options?.some(option=>typeof option.value!=='string')||field.type==='array'&&!options)throw new Error('The requested choices are not supported.');
    return {...field,name,label:field.title||name,required:(schema.required??[]).includes(name),options};
  });
}

export function elicitationResponse(params,input) {
  const action=input.action;
  if(!['accept','decline','cancel'].includes(action))throw new Error('Choose Accept, Decline or Cancel.');
  if(action!=='accept')return {action,content:null};
  if(params.mode==='url'){elicitationUrl(params.url);return {action,content:null};}
  const fields=elicitationFields(params),content=input.content;
  if(!content||typeof content!=='object'||Array.isArray(content))throw new Error('Complete the requested fields.');
  if(Object.keys(content).some(key=>!fields.some(field=>field.name===key)))throw new Error('The response contains an unrequested field.');
  const result={};
  for(const field of fields) {
    if(!Object.hasOwn(content,field.name)){if(field.required)throw new Error(`Complete “${field.label}”.`);continue;}
    const value=content[field.name],bad=()=>{throw new Error(`Check “${field.label}”.`);};
    if(field.type==='array') {
      if(!Array.isArray(value)||new Set(value).size!==value.length||value.some(item=>!field.options.some(option=>option.value===item)))bad();
      if(value.length<(field.minItems??0)||value.length>(field.maxItems??1000))bad();
    } else if(field.type==='boolean') {if(typeof value!=='boolean')bad();}
    else if(['number','integer'].includes(field.type)) {
      if(typeof value!=='number'||!Number.isFinite(value)||field.type==='integer'&&!Number.isInteger(value))bad();
      if(field.minimum!=null&&value<field.minimum||field.maximum!=null&&value>field.maximum)bad();
    } else {
      if(typeof value!=='string'||value.length<(field.minLength??0)||value.length>(field.maxLength??10000))bad();
      if(field.options&&!field.options.some(option=>option.value===value))bad();
      if(field.format==='email'&&!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))bad();
      if(field.format==='uri'){try{new URL(value);}catch{bad();}}
      if(field.format==='date'&&(!/^\d{4}-\d{2}-\d{2}$/.test(value)||!Number.isFinite(Date.parse(value))||new Date(value).toISOString().slice(0,10)!==value))bad();
      if(field.format==='date-time'&&(!Number.isFinite(Date.parse(value))||!/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)))bad();
    }
    Object.defineProperty(result,field.name,{value,enumerable:true});
  }
  return {action,content:result};
}
