function startJobRunner(opts) {
  const { lists, persistList, runJob, concurrency } = opts;
  lists.jobs = lists.jobs || { items: [] };
  const max = concurrency || 2;
  let ticking = false;

  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const running = (lists.jobs.items || []).filter((j) => j.status === 'running').length;
      const due = (lists.jobs.items || []).filter((j) => j.status === 'queued' && new Date(j.runAt).getTime() <= now);
      const take = due.slice(0, Math.max(0, max - running));
      await Promise.all(take.map(async (job) => {
        job.status = 'running';
        job.startedAt = new Date().toISOString();
        persistList('jobs');
        try {
          job.result = await runJob(job);
          job.status = 'done';
          job.error = '';
        } catch (e) {
          job.status = 'failed';
          job.error = e.publicMessage || e.message || String(e);
        }
        job.finishedAt = new Date().toISOString();
        persistList('jobs');
      }));
    } finally {
      ticking = false;
    }
  }

  setInterval(tick, 2000);
  tick();
}

module.exports = { startJobRunner };
