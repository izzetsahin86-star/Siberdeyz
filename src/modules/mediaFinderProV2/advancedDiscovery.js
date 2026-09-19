import { isMediaContentType, looksLikeMediaUrl, mediaKind } from '../mediaFinderPro/extractors.js';

const MEDIA_HINT = /m3u8|\.mpd(?:\?|$)|\.mp4(?:\?|$)|videoplayback|manifest|playlist|master\.m3u8/i;
const TRACKING_KEYS = new Set(['utm_source','utm_medium','utm_campaign','utm_term','utm_content','fbclid','gclid']);

export function decodeEmbeddedMediaText(value='') {
  return String(value)
    .replace(/\\u002[fF]/g, '/')
    .replace(/\\u003[aA]/g, ':')
    .replace(/\\\//g, '/')
    .replace(/&amp;/gi, '&')
    .replace(/&#x2F;/gi, '/')
    .replace(/&#47;/g, '/');
}

export function extractEmbeddedMediaUrls(text, baseUrl='') {
  const decoded=decodeEmbeddedMediaText(text);
  const found=new Set();
  const patterns=[
    /https?:\/\/[^"'<>\s\\]+/gi,
    /(?:\/[^"'<>\s\\]+)+(?:\.m3u8|\.mpd|\.mp4)(?:\?[^"'<>\s\\]*)?/gi,
  ];
  for(const pattern of patterns){
    for(const match of decoded.matchAll(pattern)){
      const raw=match[0].replace(/[),;]+$/,'');
      if(!MEDIA_HINT.test(raw)) continue;
      try{found.add(new URL(raw,baseUrl||undefined).toString());}catch{}
    }
  }
  return [...found];
}

export function candidateKey(rawUrl) {
  try{
    const url=new URL(rawUrl);
    url.hash='';
    for(const key of [...url.searchParams.keys()]){
      if(TRACKING_KEYS.has(key.toLowerCase())) url.searchParams.delete(key);
    }
    return url.toString();
  }catch{return String(rawUrl||'');}
}

export function addAdvancedCandidate(store, rawUrl, meta={}, max=320) {
  if(store.size>=max)return false;
  try{
    const url=new URL(String(rawUrl||''),meta.sourcePage||undefined).toString();
    if(!/^https?:\/\//i.test(url))return false;
    const type=String(meta.contentType||'').toLowerCase();
    if(!looksLikeMediaUrl(url)&&!isMediaContentType(type)&&!MEDIA_HINT.test(url))return false;
    const key=candidateKey(url);
    const next={url,title:String(meta.title||'').slice(0,180),sourcePage:String(meta.sourcePage||'').slice(0,900),discoveredBy:String(meta.discoveredBy||'v2-advanced'),contentType:type.slice(0,120),confidence:Number(meta.confidence||80),kind:mediaKind(url,type)};
    const old=store.get(key);
    if(!old||next.confidence>old.confidence)store.set(key,next);
    return true;
  }catch{return false;}
}

export async function activateFrames(page, diagnostics) {
  const frames=page.frames().slice(1,25);
  diagnostics.iframes=Math.max(diagnostics.iframes||0,frames.length);
  let clicks=0;
  for(const frame of frames){
    if(!/^https?:\/\//i.test(frame.url()))continue;
    try{
      clicks+=await frame.evaluate(()=>{
        const selectors=['video','[aria-label*="play" i]','[title*="play" i]','.vjs-big-play-button','.jw-icon-playback','.plyr__control--overlaid','button[class*="play" i]'];
        let count=0;
        for(const selector of selectors)for(const el of [...document.querySelectorAll(selector)].slice(0,5)){
          try{const r=el.getBoundingClientRect();if(r.width<2||r.height<2)continue;if(el.tagName==='VIDEO'){el.muted=true;el.play?.().catch?.(()=>{});}else el.click();count++;}catch{}
        }
        return count;
      });
    }catch{}
  }
  return clicks;
}

export async function collectFrameResources(page, candidates, meta={}) {
  for(const frame of page.frames().slice(0,25)){
    if(!/^https?:\/\//i.test(frame.url()))continue;
    try{
      const urls=await frame.evaluate(()=>performance.getEntriesByType('resource').map(x=>x.name));
      for(const url of urls)addAdvancedCandidate(candidates,url,{...meta,sourcePage:frame.url(),discoveredBy:'v2-frame-resource',confidence:90});
      const html=await frame.content();
      for(const url of extractEmbeddedMediaUrls(html,frame.url()))addAdvancedCandidate(candidates,url,{...meta,sourcePage:frame.url(),discoveredBy:'v2-frame-html',confidence:91});
    }catch{}
  }
}

export async function adaptiveListen({page,candidates,diagnostics,clickMain,sleep,shouldContinue,maxMs=18000}) {
  const started=Date.now();let lastSize=candidates.size;let quiet=0;
  while(Date.now()-started<maxMs){
    if(shouldContinue&&!(await shouldContinue()))break;
    await sleep(1800);
    diagnostics.playerClicks+=(await clickMain(page));
    diagnostics.playerClicks+=await activateFrames(page,diagnostics);
    if(candidates.size>lastSize){lastSize=candidates.size;quiet=0;}else quiet++;
    if(quiet>=3&&Date.now()-started>=7200)break;
  }
}
