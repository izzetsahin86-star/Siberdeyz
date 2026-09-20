export function mediaFinderProV2ClientSnapshot(job){
  if(!job)return null;
  return {
    jobId:job.jobId,
    mode:job.mode,
    status:job.status,
    phase:job.phase,
    message:job.message,
    createdAt:job.createdAt,
    updatedAt:job.updatedAt,
    progress:job.progress||{},
    results:(job.results||[]).map((item)=>({
      id:item.id,
      name:item.name,
      url:item.url,
      kind:item.kind,
      discoveredBy:item.discoveredBy,
    })),
  };
}
