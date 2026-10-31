const escape=value=>String(value??'').replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));

export function createWhipUi({api,refresh,desktop}){
  const toggle=document.getElementById('whip-toggle'),dialog=document.getElementById('whip-dialog'),form=document.getElementById('whip-form');
  const settings=document.getElementById('whip-settings-dialog'),settingsForm=document.getElementById('whip-settings-form');
  const entries=document.getElementById('whip-entries'),error=document.getElementById('whip-error'),settingsError=document.getElementById('whip-settings-error');
  const submit=document.getElementById('whip-enable'),settingsButton=document.getElementById('whip-settings');
  let current=null,pending=false,configuration=null,timer=null,saving=null,revision=0,savedRevision=0,returnToReminder=false;
  const row=(item,index)=>`<section class="whip-entry"><div class="whip-entry-heading"><span>Prompt ${index+1}</span><div class="whip-entry-actions"><button type="button" class="icon-button" data-whip-action="up" aria-label="Move prompt ${index+1} up"${index===0?' disabled':''}>↑</button><button type="button" class="icon-button" data-whip-action="down" aria-label="Move prompt ${index+1} down">↓</button><button type="button" class="icon-button" data-whip-action="remove" aria-label="Remove prompt ${index+1}">×</button></div></div><label class="field">Question<input data-whip-question required maxlength="240" value="${escape(item.question)}"></label><label class="field">Prompt<input data-whip-message required maxlength="2000" value="${escape(item.message)}"></label></section>`;
  function drafts(){return [...entries.querySelectorAll('.whip-entry')].map(entry=>({question:entry.querySelector('[data-whip-question]').value,message:entry.querySelector('[data-whip-message]').value}));}
  function valid(items){return items.every(item=>[item.question,item.message].every(text=>text.trim()&&!/[\u0000-\u001f\u007f-\u009f]/u.test(text)&&text.isWellFormed()));}
  function draw(items){
    entries.innerHTML=items.map(row).join('');
    [...entries.children].forEach((entry,index)=>{
      entry.querySelector('[data-whip-action="down"]').disabled=index===items.length-1;
      entry.querySelector('[data-whip-action="remove"]').disabled=items.length===1;
    });document.getElementById('whip-add').disabled=items.length>=100;
  }
  function render(snapshot){
    current=snapshot;
    toggle.hidden=!desktop||!snapshot?.supported;toggle.disabled=pending||!snapshot?.supported||snapshot.busy;
    toggle.setAttribute('aria-checked',String(!!snapshot?.enabled));toggle.setAttribute('aria-label',`Whip ${snapshot?.enabled?'on':'off'}`);
  }
  function openReminder(message=null){
    error.textContent=message||current.error||'';error.hidden=!error.textContent;
    dialog.showModal();
  }
  async function saveSettings(){
    clearTimeout(timer);timer=null;
    if(saving)return saving;
    if(!configuration||savedRevision===revision)return;
    const items=drafts();
    if(!valid(items)){settingsError.textContent='Use nonempty, single-line questions and prompts.';settingsError.hidden=false;return;}
    saving=(async()=>{
      while(savedRevision!==revision){
        const sentRevision=revision,messages=drafts();
        if(!valid(messages)){settingsError.textContent='Use nonempty, single-line questions and prompts.';settingsError.hidden=false;break;}
        try{
          render(await api('/api/whip',{method:'POST',body:{configuration:{...configuration,messages}}}));
          configuration=structuredClone(current.configuration);savedRevision=sentRevision;settingsError.hidden=true;
        }catch(reason){settingsError.textContent=reason.message;settingsError.hidden=false;break;}
      }
    })();
    try{await saving;}finally{saving=null;}
  }
  function changed(){revision++;clearTimeout(timer);timer=setTimeout(()=>{void saveSettings();},200);}
  toggle.addEventListener('click',async()=>{
    if(pending||!current?.supported)return;
    if(current.enabled){
      pending=true;render(current);
      try{render(await api('/api/whip',{method:'POST',body:{enabled:false}}));await refresh();}
      catch(reason){await refresh();openReminder(reason.message);}
      finally{pending=false;render(current);}return;
    }
    openReminder();
  });
  settingsButton.addEventListener('click',()=>{
    if(pending)return;
    configuration=structuredClone(current.configuration);revision=savedRevision=0;draw(configuration.messages);settingsError.hidden=true;
    returnToReminder=true;dialog.close();settings.showModal();
  });
  settingsForm.addEventListener('input',changed);
  settingsForm.addEventListener('change',()=>{void saveSettings();});
  settingsForm.addEventListener('submit',event=>{event.preventDefault();void saveSettings();});
  settingsForm.addEventListener('click',event=>{
    const button=event.target.closest('[data-whip-action]');if(!button)return;
    const action=button.dataset.whipAction,items=drafts();
    if(action==='add')items.push({question:'',message:''});
    else{
      const index=[...entries.children].indexOf(button.closest('.whip-entry'));
      if(action==='remove')items.splice(index,1);
      if(action==='up'&&index>0)[items[index-1],items[index]]=[items[index],items[index-1]];
      if(action==='down'&&index<items.length-1)[items[index],items[index+1]]=[items[index+1],items[index]];
    }draw(items);changed();void saveSettings();
    if(action==='add')entries.lastElementChild.querySelector('input').focus();
  });
  settings.addEventListener('close',()=>{
    const reopen=returnToReminder;returnToReminder=false;
    void saveSettings().then(()=>{if(reopen&&!dialog.open&&!settings.open)openReminder(settingsError.hidden?null:settingsError.textContent);});
  });
  form.addEventListener('submit',async event=>{
    event.preventDefault();if(pending)return;
    pending=true;dialog.dataset.busy='true';submit.disabled=true;settingsButton.disabled=true;error.hidden=true;render(current);
    dialog.querySelectorAll('[data-close-dialog]').forEach(button=>button.disabled=true);
    try{
      render(await api('/api/whip',{method:'POST',body:{enabled:true,confirmed:true}}));
      dialog.close();await refresh();
    }catch(reason){error.textContent=reason.message;error.hidden=false;}
    finally{pending=false;delete dialog.dataset.busy;submit.disabled=false;settingsButton.disabled=false;dialog.querySelectorAll('[data-close-dialog]').forEach(button=>button.disabled=false);render(current);}
  });
  dialog.addEventListener('cancel',event=>{if(pending)event.preventDefault();});
  return {render};
}
