// Run async tasks with a concurrency cap. Shared by the server side (hashing
// every jar of a 300-mod pack at once would thrash the disk and blow through
// the open-file limit) and the launcher (a burst of Modrinth lookups trips its
// 300 req/min/IP rate limit).
//
// `tasks` is an array of zero-argument async functions. A task that throws
// rejects the whole run, so callers catch inside the task when one failure
// shouldn't stop the rest.
async function runWithConcurrency(tasks, limit) {
  const queue = tasks.slice();
  const workers = Array.from({ length: Math.min(limit, queue.length) }, async () => {
    while (queue.length) {
      const task = queue.shift();
      if (task) await task();
    }
  });
  await Promise.all(workers);
}

module.exports = { runWithConcurrency };
