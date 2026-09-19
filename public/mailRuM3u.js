const input=document.querySelector('#mailRuM3uUrl');
const button=document.querySelector('#mailRuM3uFind');
const status=document.querySelector('#mailRuM3uStatus');
const result=document.querySelector('#mailRuM3uResult');
function setStatus(message,type='info'){if(!status)return;status.textContent=message;status.dataset.type=type;status.hidden=!message}
function esc(v){return String(v??'').replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]))}
async function resolve(){
 const url=String(input?.value||'').trim(); if(!url){setStatus('Mail.ru video linkini girin.','warning');return}
 button.disabled=true;button.textContent='Bulunuyor...';result.innerHTML='';setStatus('Mail.ru yayini cozumleniyor...');
 try{
  const r=await fetch('/api/mailru-m3u/resolve',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({url})});
  const d=await r.json().catch(()=>({})); if(!r.ok)throw new Error(d.error||'Yayin bulunamadi');
  const added=d.saved?.added!==false;
  setStatus(added?'Yayin bulundu ve M3U Yayınlarım hesabına kaydedildi.':'Bu yayin M3U Yayınlarım hesabında zaten kayıtlı.','success');
  result.innerHTML='<article class="web-scan-result is-selected"><span class="web-scan-result-copy"><strong>'+esc(d.title)+'</strong><small>'+esc(d.best?.quality||'auto')+' · M3U Yayınlarım · Toplam '+esc(d.saved?.channelCount||1)+' yayın</small></span></article>';
 }catch(e){setStatus(e.message,'error')}finally{button.disabled=false;button.textContent='Yayini Bul'}
}
button?.addEventListener('click',()=>resolve());
input?.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();resolve()}});
