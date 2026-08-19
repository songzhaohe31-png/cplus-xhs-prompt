function startJobRunner(opts) {
  const { lists, persistList, runJob } = opts;
  lists.jobs = lists.jobs || { items: [] };
  setInterval(async () => {
    const now = Date.now();
    const due = (lists.jobs.items || []).filter((j) => j.status === 'queued' && new Date(j.runAt).getTime() <= now);
    for (const job of due) {
      job.status = 'running';
      job.startedAt = new Date().toISOString();
      persistList('jobs');
      try {
        job.result = await runJob(job);
        job.status = 'done';
        job.error = '';
      } catch (e) {
        job.status = 'failed';
        job.error = e.message || String(e);
      }
      job.finishedAt = new Date().toISOString();
      persistList('jobs');
    }
  }, 20000);
}

module.exports = { startJobRunner };
