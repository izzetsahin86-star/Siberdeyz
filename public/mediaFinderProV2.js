function api(path,options){return fetch('/api/media-finder-pro-v2'+path,options).then(async r=>{const d=await r.json().catch(()=>({}));if(!r.ok)throw new Error(d.error||'V2 istegi basarisiz.');return d;});}
function normalizeUrlInput(value){
  const text=String(value||'').trim();
  if(!text)return '';
  if(/^https?:\/\//i.test(text))return text;
  return 'https://'+text.replace(/^\/+/, '');
}
function ensureUi(){
  if(document.querySelector('#mediaProV2Section'))return;
  const tabs=document.querySelector('#webScanView .web-scan-mode-tabs'); if(!tabs)return;
  const tab=document.createElement('button');tab.type='button';tab.className='web-scan-mode-tab';tab.dataset.webScanMode='prov2';tab.textContent='Yayin Bul Pro V2';tabs.append(tab);
  const section=document.createElement('section');section.id='mediaProV2Section';section.className='web-scan-mode-section media-pro-v2';section.hidden=true;
  section.innerHTML='<div class="media-pro-v2-toolbar"><select id="mediaProV2Mode"><option value="search">Site + Film/Oyuncu</option><option value="direct">Dogrudan Yayin/Sayfa Linki</option></select><input id="mediaProV2Url" placeholder="https://site.com" inputmode="url"><input id="mediaProV2Query" placeholder="Film veya oyuncu adi"><button id="mediaProV2Start">V2 Derin Tara</button></div><div id="mediaProV2Status" class="media-pro-v2-status">Hazir.</div><div class="media-pro-v2-actions"><button id="mediaProV2Stop" hidden>Durdur</button><button id="mediaProV2Clear">Sonuclari Temizle</button></div><div id="mediaProV2Results" class="media-pro-v2-results"></div><div id="mediaProV2SaveBar" class="media-pro-v2-save" hidden><input id="mediaProV2Label" placeholder="Kayit adi (istege bagli)"><button id="mediaProV2Save">Secilenleri Kaydet</button></div>';
  document.querySelector('#webScanView').append(section);
  const link=document.createElement('link');link.rel='stylesheet';link.href='/mediaFinderProV2.css';document.head.append(link);
}
export function createMediaFinderProV2Controller({onSaved}={}){
  ensureUi(); const $=s=>document.querySelector(s); let job=null,timer=null,renderedJobId='';
  const resultRows=new Map();
  const resultsRoot=$('#mediaProV2Results');
  const panel=$('#mediaProV2Section')?.closest('.content-panel');
  function show(){document.querySelectorAll('#webScanView .web-scan-mode-section').forEach(x=>x.hidden=x.id!=='mediaProV2Section');document.querySelectorAll('#webScanView .web-scan-mode-tab').forEach(x=>x.classList.toggle('is-active',x.dataset.webScanMode==='prov2'));}
  document.querySelector('[data-web-scan-mode="prov2"]')?.addEventListener('click',show);
  document.querySelector('#webScanView .web-scan-mode-tabs')?.addEventListener('click',(event)=>{
    const button=event.target.closest('[data-web-scan-mode]');
    if(!button)return;
    const mode=button.dataset.webScanMode||'quick';
    const targetIds={quick:'quickWebScanSection',full:'fullSiteScanSection',mailru:'mailRuM3uSection',prov2:'mediaProV2Section'};
    const targetId=targetIds[mode];
    document.querySelectorAll('#webScanView .web-scan-mode-section').forEach(section=>{section.hidden=section.id!==targetId;});
    document.querySelectorAll('#webScanView .web-scan-mode-tab').forEach(tab=>tab.classList.toggle('is-active',tab===button));
  });
  $('#mediaProV2Url')?.addEventListener('blur',()=>{const value=normalizeUrlInput($('#mediaProV2Url').value);if(value)$('#mediaProV2Url').value=value;});
  $('#mediaProV2Mode')?.addEventListener('change',()=>{$('#mediaProV2Query').hidden=$('#mediaProV2Mode').value==='direct';});
  function clearRenderedResults(){
    resultRows.clear();
    resultsRoot?.replaceChildren();
  }
  function createResultRow(result){
    const card=document.createElement('label');
    card.className='media-pro-v2-card';
    const line=document.createElement('span');
    const checkbox=document.createElement('input');
    checkbox.type='checkbox';
    checkbox.dataset.v2Id=String(result.id||'');
    checkbox.checked=true;
    const title=document.createElement('strong');
    title.textContent=String(result.name||'');
    const meta=document.createElement('small');
    meta.textContent=String(result.kind||'')+' · '+String(result.discoveredBy||'');
    line.append(checkbox,title);
    card.append(line,meta);
    resultRows.set(String(result.id||''),{card,title,meta});
    return card;
  }
  function renderResults(results){
    if(!resultsRoot)return;
    const currentIds=new Set(results.map(result=>String(result.id||'')));
    for(const [id,row] of resultRows){
      if(currentIds.has(id))continue;
      row.card.remove();
      resultRows.delete(id);
    }
    if(!results.length){
      if(!resultRows.size&&resultsRoot.firstElementChild?.dataset.v2Empty==='true')return;
      clearRenderedResults();
      const empty=document.createElement('div');
      empty.className='media-pro-v2-card';
      empty.dataset.v2Empty='true';
      empty.textContent='Henuz dogrulanmis yayin yok.';
      resultsRoot.replaceChildren(empty);
      return;
    }
    if(!resultRows.size)resultsRoot.replaceChildren();
    const fragment=document.createDocumentFragment();
    for(const result of results){
      const id=String(result.id||'');
      const existing=resultRows.get(id);
      if(existing){
        const name=String(result.name||'');
        const meta=String(result.kind||'')+' · '+String(result.discoveredBy||'');
        if(existing.title.textContent!==name)existing.title.textContent=name;
        if(existing.meta.textContent!==meta)existing.meta.textContent=meta;
        continue;
      }
      fragment.append(createResultRow(result));
    }
    if(fragment.childNodes.length)resultsRoot.append(fragment);
  }
  function render(d){
    if(!d)return;job=d;$('#mediaProV2Status').textContent=d.message||'';$('#mediaProV2Status').dataset.type=d.status==='failed'?'error':'';
    const active=['running','stopping'].includes(d.status);
    $('#mediaProV2Stop').hidden=!active;
    panel?.classList.toggle('is-pro-v2-working',active);
    const results=d.results||[];
    const nextJobId=String(d.jobId||'');
    if(nextJobId!==renderedJobId){clearRenderedResults();renderedJobId=nextJobId;}
    renderResults(results);
    $('#mediaProV2SaveBar').hidden=!results.length;
  }
  async function poll(){try{const d=await api('/status',{cache:'no-store'});render(d);if(d&&['running','stopping'].includes(d.status)){timer=setTimeout(poll,d.phase==='testing'?1600:2200);}}catch{}}
  $('#mediaProV2Start')?.addEventListener('click',async()=>{clearTimeout(timer);try{const mode=$('#mediaProV2Mode').value;const normalizedUrl=normalizeUrlInput($('#mediaProV2Url').value);$('#mediaProV2Url').value=normalizedUrl;const d=await api('/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode,url:normalizedUrl,query:$('#mediaProV2Query').value})});render(d);poll();}catch(e){$('#mediaProV2Status').textContent=e.message;$('#mediaProV2Status').dataset.type='error';}});
  $('#mediaProV2Stop')?.addEventListener('click',async()=>render(await api('/stop',{method:'POST'})));
  $('#mediaProV2Clear')?.addEventListener('click',async()=>{if(!job)return;await api('/'+encodeURIComponent(job.jobId)+'/results',{method:'DELETE'});job=null;renderedJobId='';render({message:'Sonuclar temizlendi.',progress:{},results:[],rejected:[]});});
  $('#mediaProV2Save')?.addEventListener('click',async()=>{if(!job)return;const ids=[...resultsRoot.querySelectorAll('[data-v2-id]:checked')].map(x=>x.dataset.v2Id);try{const d=await api('/'+encodeURIComponent(job.jobId)+'/save',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({ids,label:$('#mediaProV2Label').value})});$('#mediaProV2Status').textContent=ids.length+' yayin kaydedildi.';await onSaved?.(d);}catch(e){$('#mediaProV2Status').textContent=e.message;}});
  poll(); return{show,refresh:poll};
}
