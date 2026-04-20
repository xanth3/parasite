const $ = (selector, root = document) => root.querySelector(selector);

export async function mountQueue() {
  $('#btn-queue-clear').addEventListener('click', async () => {
    await window.api.queue.clearDone();
    await render();
  });
  window.api.queue.onUpdate(() => render());
  window.api.queue.onProgress(() => render());
  await render();
  setInterval(render, 2000);
}

async function render() {
  const jobs = await window.api.queue.list();
  const pending = jobs.filter((job) => job.status === 'pending' || job.status === 'running').length;
  const badge = $('#queue-badge');
  badge.textContent = pending;
  badge.hidden = pending === 0;

  const body = $('#queue-body');
  if (!jobs.length) {
    body.innerHTML = '<div class="empty">Queue is empty. Pick clips from Library and use Add to Queue or Queue it on an export.</div>';
    return;
  }

  body.innerHTML = '';
  for (const job of jobs) {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const name = job.item_name || (job.video_path ? job.video_path.split(/[/\\]/).pop() : 'Unavailable media');
    row.innerHTML = `
      <div>
        <div class="q-name"></div>
        <div class="q-sub"></div>
      </div>
      <div class="q-action">${job.action}</div>
      <div>
        <div class="progress"><div class="progress-bar"></div></div>
        <div class="q-sub">${Math.round((job.progress || 0) * 100)}%</div>
      </div>
      <div class="q-status q-${job.status}"></div>
    `;
    row.querySelector('.q-name').textContent = name;
    row.querySelector('.q-sub').textContent = new Date(job.created_at).toLocaleString();
    row.querySelector('.progress-bar').style.width = `${Math.round((job.progress || 0) * 100)}%`;
    row.querySelector('.q-status').textContent = job.error ? `${job.status} - ${job.error.slice(0, 80)}` : job.status;
    body.appendChild(row);
  }
}
