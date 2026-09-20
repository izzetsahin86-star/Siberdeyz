import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { discoverMatchingPages } from './mediaFinderPro/discovery.js';
import { probeMediaCandidate } from './mediaFinderPro/probe.js';
import { mediaId, safeMediaName } from './mediaFinderPro/extractors.js';
import { assertPublicHttpUrl } from './mediaFinderPro/urlSafety.js';
import { deepDiscoverV2 } from './mediaFinderProV2/browserEngine.js';
import { getTenantDataDir, getTenantId } from './tenantContext.js';
import { saveWebScanPlaylistSource } from './sourceStorage.js';
import { mediaFinderProV2ClientSnapshot } from './mediaFinderProV2/clientSnapshot.js';
import { groupQualityVariantCandidates } from './mediaFinderProV2/qualityDeduper.js';

const jobs = new Map();
const ACTIVE = new Set(['running','stopping']);
function filePath(){ return path.join(getTenantDataDir(),'media-finder-pro-v2-job.json'); }
async function persist(j){ j.updatedAt=new Date().toISOString(); await fs.mkdir(getTenantDataDir(),{recursive:true}); await fs.writeFile(filePath(),JSON.stringify(j,null,2)); }
async function stored(){ try{return JSON.parse(await fs.readFile(filePath(),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;} }
async function canRun(j){ return j.status==='running'; }

async function run(job){
  try{
    let pages=[];
    if(job.mode==='search'){
      job.phase='searching'; job.message='V2: site icinde film/oyuncu sayfalari derin araniyor...'; await persist(job);
      const found=await discoverMatchingPages(job.targetUrl,job.query,120,{
        shouldContinue:()=>canRun(job),
        onProgress:async(p)=>{job.progress.pagesVisited=p.pagesVisited||0;job.progress.matchesFound=p.matchesFound||0;await persist(job);}
      });
      pages=found.pages;
      job.matches=pages;
      job.progress.matchesFound=pages.length;
      job.diagnostics.search=found.diagnostics;
      if(!pages.length){job.status='completed';job.phase='completed';job.message='V2: eslesen sayfa bulunamadi.';await persist(job);return;}
    } else {
      pages=[{url:job.targetUrl,title:'Dogrudan baglanti',source:'direct'}];
      job.matches=pages; job.progress.matchesFound=1;
    }

    job.phase='browser'; job.message='V2: gercek Chromium ile oynaticilar tetikleniyor ve ag trafigi dinleniyor...'; await persist(job);
    const deep=await deepDiscoverV2(pages,{
      shouldContinue:()=>canRun(job),
      onProgress:async(p)=>{job.progress.pagesOpened=p.pagesOpened;job.progress.playerClicks=p.playerClicks;job.progress.candidates=p.candidates;job.diagnostics.browser=p;await persist(job);}
    });
    if(job.status==='stopping'){job.status='stopped';job.phase='stopped';job.message='V2 durduruldu.';await persist(job);return;}
    job.diagnostics.browser=deep.diagnostics;
    job.progress.candidates=deep.candidates.length;

    job.phase='testing'; job.message=deep.candidates.length+' aday bulundu; yayinlar dogrulaniyor...'; await persist(job);
    const results=[]; const rejected=[];
    const groups=groupQualityVariantCandidates(deep.candidates)
      .sort((left,right)=>Math.max(...right.map(item=>Number(item.confidence||0)))-Math.max(...left.map(item=>Number(item.confidence||0))));
    let attempts=0;
    for(const group of groups){
      if(!(await canRun(job))||attempts>=200) break;
      let accepted=null;
      for(const candidate of group){
        if(!(await canRun(job))||attempts>=200) break;
        attempts+=1;
        try{
          const probe=await probeMediaCandidate(candidate);
          accepted={
            id:mediaId(candidate.url), name:String(candidate.title||pages.find(p=>p.url===candidate.sourcePage)?.title||job.query||safeMediaName(candidate.url,results.length+1,'')).trim(),
            url:candidate.url, kind:probe.kind, sourcePage:candidate.sourcePage,
            discoveredBy:candidate.discoveredBy, durationSeconds:probe.durationSeconds||null,
            live:Boolean(probe.live), confidence:candidate.confidence||0,
            qualityHeight:candidate.qualityHeight||null
          };
        }catch(error){
          const reason=String(error?.message||'Dogrulanamadi').slice(0,180);
          rejected.push({url:candidate.url,kind:candidate.kind||'',reason,sourcePage:candidate.sourcePage});
        }
        job.progress.tested=(job.progress.tested||0)+1;
        job.progress.rejected=rejected.length;
        if(accepted) break;
        if(job.progress.tested%12===0) await persist(job);
        await new Promise((resolve)=>setImmediate(resolve));
      }
      if(accepted) results.push(accepted);
      job.progress.accepted=results.length;
      job.results=results.slice(0,100);
      job.rejected=rejected.slice(-20);
      if(job.progress.tested%12===0) await persist(job);
      await new Promise((resolve)=>setImmediate(resolve));
    }
    job.status='completed';job.phase='completed';
    job.message=results.length?results.length+' calisan yayin bulundu.':deep.candidates.length?'Adaylar yakalandi ancak dogrulama gecemedi. Nedenleri asagida listelendi.':'Oynatici tetiklendi ancak medya istegi yakalanamadi.';
    await persist(job);
  }catch(error){job.status='failed';job.phase='failed';job.message=String(error?.message||'V2 tarama basarisiz.').slice(0,260);await persist(job).catch(()=>{});}
  finally{jobs.delete(job.tenantId);}
}

export async function startMediaFinderProV2({mode,url,query}={}){
  const tenantId=getTenantId(); const active=jobs.get(tenantId);
  if(active&&ACTIVE.has(active.status)){const e=new Error('V2 tarama zaten calisiyor.');e.status=409;throw e;}
  const selected=mode==='direct'?'direct':'search';
  const targetUrl=(await assertPublicHttpUrl(url)).toString();
  const q=String(query||'').replace(/\s+/g,' ').trim();
  if(selected==='search'&&q.length<2){const e=new Error('Film veya oyuncu adi en az 2 karakter olmali.');e.status=400;throw e;}
  const now=new Date().toISOString();
  const job={tenantId,jobId:'prov2_'+crypto.randomBytes(10).toString('hex'),mode:selected,targetUrl,query:selected==='search'?q:'',status:'running',phase:'queued',message:'Yayin Bul Pro V2 hazirlaniyor...',createdAt:now,updatedAt:now,progress:{pagesVisited:0,matchesFound:0,pagesOpened:0,playerClicks:0,candidates:0,tested:0,accepted:0,rejected:0},diagnostics:{},matches:[],results:[],rejected:[]};
  jobs.set(tenantId,job);await persist(job);setImmediate(()=>run(job));return mediaFinderProV2ClientSnapshot(job);
}
export async function getMediaFinderProV2Status(){return mediaFinderProV2ClientSnapshot(jobs.get(getTenantId())||await stored());}
export async function stopMediaFinderProV2(){const j=jobs.get(getTenantId());if(j){j.status='stopping';j.message='V2 durduruluyor...';await persist(j);}return mediaFinderProV2ClientSnapshot(j||await stored());}
export async function clearMediaFinderProV2(jobId){const j=jobs.get(getTenantId())||await stored();if(!j||j.jobId!==jobId){const e=new Error('V2 sonucu bulunamadi.');e.status=404;throw e;}if(ACTIVE.has(j.status)){const e=new Error('Calisan V2 taramasi once durdurulmali.');e.status=409;throw e;}await fs.unlink(filePath()).catch(e=>{if(e.code!=='ENOENT')throw e;});return{cleared:true};}
export async function saveMediaFinderProV2(jobId,ids,label=''){const j=jobs.get(getTenantId())||await stored();if(!j||j.jobId!==jobId){const e=new Error('V2 sonucu bulunamadi.');e.status=404;throw e;}const set=new Set((ids||[]).map(String));const selected=(j.results||[]).filter(x=>set.has(x.id));if(!selected.length){const e=new Error('En az bir yayin secin.');e.status=400;throw e;}return saveWebScanPlaylistSource({label:String(label||'').trim()||('Yayin Bul Pro V2 · '+(j.query||new URL(j.targetUrl).hostname)),pageUrl:j.targetUrl,channels:selected.map(x=>({name:x.name,group:'Yayin Bul Pro V2',url:x.url,webDurationSeconds:x.durationSeconds||null,webDurationStatus:x.durationSeconds?'known':'unknown'}))});}
