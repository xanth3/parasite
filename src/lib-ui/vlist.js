// Tiny vanilla virtual list.
// Keeps DOM row count bounded regardless of dataset size — Unedited can
// happily hold 10k rows without the main thread breaking a sweat.

const BUFFER_ROWS = 6;

export class VirtualList {
  constructor({ viewport, spacer, rows, rowHeight, renderRow }) {
    this.viewport = viewport;
    this.spacer = spacer;
    this.rows = rows;
    this.rowHeight = rowHeight;
    this.renderRow = renderRow;
    this.items = [];
    this._scheduled = false;
    this._onScroll = this._onScroll.bind(this);
    this.viewport.addEventListener('scroll', this._onScroll, { passive: true });
    new ResizeObserver(() => this._draw()).observe(this.viewport);
  }

  setItems(items, { resetScroll = false } = {}) {
    this.items = items;
    this.spacer.style.height = `${items.length * this.rowHeight}px`;
    if (resetScroll) this.viewport.scrollTop = 0;
    this._draw();
  }

  refresh() { this._draw(); }

  _onScroll() {
    if (this._scheduled) return;
    this._scheduled = true;
    requestAnimationFrame(() => {
      this._scheduled = false;
      this._draw();
    });
  }

  _draw() {
    const { items, rowHeight, rows, viewport, renderRow } = this;
    if (!items.length) { rows.innerHTML = ''; return; }
    const scrollTop = viewport.scrollTop;
    const visible = Math.ceil(viewport.clientHeight / rowHeight);
    const start = Math.max(0, Math.floor(scrollTop / rowHeight) - BUFFER_ROWS);
    const end = Math.min(items.length, start + visible + BUFFER_ROWS * 2);

    rows.style.transform = `translateY(${start * rowHeight}px)`;
    rows.innerHTML = '';
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const node = renderRow(items[i], i);
      node.style.height = `${rowHeight}px`;
      frag.appendChild(node);
    }
    rows.appendChild(frag);
  }
}
