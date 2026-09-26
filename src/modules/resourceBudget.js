// A single heavyweight operation at a time keeps Chromium and account scans
// from exhausting the 1 GB Railway instance. Tasks release the slot even on error.
let nextSlot = Promise.resolve();

export function withHeavyTask(task) {
  const previous = nextSlot;
  let release;
  nextSlot = new Promise((resolve) => { release = resolve; });

  return previous.then(async () => {
    try {
      return await task();
    } finally {
      release();
    }
  });
}
