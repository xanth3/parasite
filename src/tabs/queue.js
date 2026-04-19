// Queue tab. Live view of the persistent batch job list.

const $ = (sel, root = document) => root.querySelector(sel);

let _toast;

export async function mountQueue({ toast }) {
  _toast = toast;
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
  const pending = jobs.filter((j) => j.status === 'pending' || j.status === 'running').length;
  const badge = $('#queue-badge');
  badge.textContent = pending;
  badge.hidden = pending === 0;

  const body = $('#queue-body');
  if (!jobs.length) {
    body.innerHTML = `<div class="empty">Queue is empty. Pick clips from Library and hit "Add to Queue" or "Queue it" on an export.</div>`;
    return;
  }
  body.innerHTML = '';
  for (const j of jobs) {
    const row = document.createElement('div');
    row.className = 'queue-row';
    const name = j.video_path.split(/[/\\]/).pop();
    row.innerHTML = `
      <div>
        <div class="q-name"></div>
        <div class="q-sub"></div>
      </div>
      <div class="q-action">${j.action}</div>
      <div>
        <div class="progress"><div class="progress-bar"></div></div>
        <div class="q-sub">${Math.round((j.progress || 0) * 100)}%</div>
      </div>
      <div class="q-status q-${j.status}">${j.status}${j.error ? ' — ' + escape(j.error).slice(0, 80) : ''}</div>
    `;
    row.querySelector('.q-name').textContent = name;
    row.querySelector('.q-sub').textContent = new Date(j.created_at).toLocaleString();
    row.querySelector('.progress-bar').style.width = `${Math.round((j.progress || 0) * 100)}%`;
    body.appendChild(row);
  }
}

function escape(s) { return String(s).replace(/[&<>"']/g, (c) => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c])); }
