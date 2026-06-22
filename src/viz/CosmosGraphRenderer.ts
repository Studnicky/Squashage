/**
 * @fileoverview CosmosGraphRenderer — emits a self-contained HTML wrapper that
 * loads the cosmos.gl/graph WebGL bundle and streams a COMPACT BINARY graph via
 * a Web Worker, uploading each concept frame with a low-alpha warm restart so
 * clusters animate into their baked positions and settle.
 *
 * @module viz/CosmosGraphRenderer
 *
 * ## Runtime payload
 * The generated HTML reads {@link BinaryFrameManifestInterface} (`manifest.json`)
 * and per-frame `frames/frame-NNN.bin` files described by
 * `viz/BinaryFrameFormat`. The HTML is fully self-contained: it inlines the
 * vendored cosmos.gl bundle, the main-thread init script, and the worker source
 * (instantiated from a Blob URL — no separate `.js` file, no module imports).
 * This is required for GitHub Pages, which serves over plain http without the
 * COOP/COEP cross-origin-isolation headers SharedArrayBuffer would need.
 *
 * ## Streaming pipeline
 *   1. Main thread fetches `manifest.json`, allocates capacity-sized
 *      accumulation buffers (`totalNodes`/`totalEdges`), and renders the
 *      streaming-queue UI with per-concept color swatches.
 *   2. Main thread posts `{cmd:'start', manifestUrl, baseUrl}` to the worker.
 *   3. Worker re-fetches the manifest, then for each frame in order fetches the
 *      `.bin`, validates magic/version, COPIES the four typed-array regions into
 *      fresh `ArrayBuffer`s, and posts `{type:'frame', …}` transferring those
 *      buffers (the transfer list — true zero-copy hand-off, no SharedArrayBuffer).
 *   4. Main thread copies each frame's data into the accumulation buffers at the
 *      frame's global offset and uploads the live prefix
 *      (`subarray(0, live*stride)` — a zero-copy view) to cosmos with a warm
 *      restart at alpha 0.1 (1.0 on the first frame).
 *   5. On `{type:'complete'}` the loading overlay hides and the view fits.
 *
 * @category Viz
 * @since 0.10.0
 */
import { COSMOS_BUNDLE } from './vendor/cosmosBundle.js';

/**
 * Options for {@link CosmosGraphRenderer.render}.
 *
 * @category Viz
 * @since 0.10.0
 * @group Types
 */
export interface CosmosRenderOptionsInterface {
  /** HTML page title. Default: `'Squashage Graph'`. */
  readonly title?:    string;
  /** Path (relative or absolute URL) to `manifest.json`. Default: `'./manifest.json'`. */
  readonly indexUrl?: string;
}

/**
 * Static-only renderer that emits the standalone cosmos.gl HTML wrapper.
 *
 * The runtime payload (`manifest.json` + `frames/*.bin`) is produced separately
 * by the binary-frame exporter and must sit alongside the emitted HTML.
 *
 * @category Viz
 * @since 0.10.0
 * @group Core
 *
 * @example
 * ```ts
 * import { writeFileSync } from 'node:fs';
 * import { CosmosGraphRenderer } from './viz/CosmosGraphRenderer.js';
 *
 * const html = CosmosGraphRenderer.render({ title: 'Squashage', indexUrl: './manifest.json' });
 * writeFileSync('dist/viz/index.html', html);
 * ```
 */
export class CosmosGraphRenderer {
  private constructor() { /* static-only */ }

  /**
   * Renders the standalone HTML wrapper as a single self-contained string.
   *
   * @param opts - Title and manifest URL overrides; see {@link CosmosRenderOptionsInterface}.
   * @returns A complete HTML document that streams the binary graph via a Web Worker.
   */
  static render(opts: CosmosRenderOptionsInterface = {}): string {
    const title    = opts.title    ?? 'Squashage Graph';
    const indexUrl = opts.indexUrl ?? './manifest.json';
    return CosmosGraphRenderer.#html(title, indexUrl);
  }

  // ---- Private ------------------------------------------------------------

  static #esc(s: string): string {
    return s
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  static #html(title: string, indexUrl: string): string {
    const optionsJson = JSON.stringify({ indexUrl });
    const workerJson  = JSON.stringify(CosmosGraphRenderer.#workerScript());
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<title>${CosmosGraphRenderer.#esc(title)}</title>`,
      '<style>',
      CosmosGraphRenderer.#css(),
      '</style>',
      '</head>',
      '<body>',
      `<header class="sq-header"><h1>${CosmosGraphRenderer.#esc(title)}</h1><span class="sq-tag">streaming • cosmos.gl webgl • binary frames • forceatlas2</span><button class="sq-physics-toggle" id="sq-physics-toggle" title="Toggle physics panel">Physics</button></header>`,
      '<div class="sq-layout">',
      '  <div id="cy">',
      '    <div id="sq-dpad-wrap" class="sq-dpad-wrap">',
      '      <div class="sq-zoom-hud" id="sq-zoom-hud">1.00×</div>',
      '      <div class="sq-dpad">',
      '        <button class="sq-dpad-btn" id="sq-btn-zoom-in"  title="Zoom in">+</button>',
      '        <button class="sq-dpad-btn sq-dpad-disabled" id="sq-btn-pan-up"   title="Pan unavailable (drag the canvas)" disabled>▲</button>',
      '        <button class="sq-dpad-btn" id="sq-btn-zoom-out" title="Zoom out">−</button>',
      '        <button class="sq-dpad-btn sq-dpad-disabled" id="sq-btn-pan-left" title="Pan unavailable (drag the canvas)" disabled>◀</button>',
      '        <button class="sq-dpad-btn" id="sq-btn-centre"   title="Centre">⊙</button>',
      '        <button class="sq-dpad-btn sq-dpad-disabled" id="sq-btn-pan-right" title="Pan unavailable (drag the canvas)" disabled>▶</button>',
      '        <button class="sq-dpad-btn" id="sq-btn-fullscreen" title="Toggle fullscreen">⛶</button>',
      '        <button class="sq-dpad-btn sq-dpad-disabled" id="sq-btn-pan-down" title="Pan unavailable (drag the canvas)" disabled>▼</button>',
      '        <button class="sq-dpad-btn" id="sq-btn-fit"      title="Fit view">⤢</button>',
      '      </div>',
      '    </div>',
      '    <div id="sq-physics-panel" class="sq-physics-panel sq-hidden">',
      '      <div class="sq-physics-header">',
      '        <span>Physics</span>',
      '        <button class="sq-physics-close" id="sq-physics-close">×</button>',
      '      </div>',
      '      <div class="sq-physics-row"><label>Gravity<input type="range" id="sq-phys-gravity" min="0" max="5" step="0.01" value="1"></label><span id="sq-phys-gravity-val">1</span></div>',
      '      <div class="sq-physics-row"><label>Repulsion<input type="range" id="sq-phys-repulsion" min="0" max="10" step="0.01" value="1"></label><span id="sq-phys-repulsion-val">1</span></div>',
      '      <div class="sq-physics-row"><label>Link Spring<input type="range" id="sq-phys-spring" min="0" max="5" step="0.01" value="1"></label><span id="sq-phys-spring-val">1</span></div>',
      '      <div class="sq-physics-row"><label>Link Distance<input type="range" id="sq-phys-dist" min="1" max="200" step="1" value="10"></label><span id="sq-phys-dist-val">10</span></div>',
      '      <div class="sq-physics-row"><label>Friction<input type="range" id="sq-phys-friction" min="0" max="1" step="0.01" value="0.1"></label><span id="sq-phys-friction-val">0.1</span></div>',
      '      <div class="sq-physics-row"><label>Decay<input type="range" id="sq-phys-decay" min="100" max="10000" step="100" value="100000"></label><span id="sq-phys-decay-val">∞</span></div>',
      '      <button class="sq-physics-reset" id="sq-physics-reset">Reset</button>',
      '    </div>',
      '  </div>',
      '  <div id="sq-loading-overlay" class="sq-loading-overlay sq-hidden">',
      '    <div class="sq-spinner"></div>',
      '    <div id="sq-loading-msg" class="sq-loading-msg">Loading…</div>',
      '  </div>',
      '  <aside class="sq-sidebar">',
      '    <section class="sq-section" id="sq-stats">',
      '      <h2>Stats</h2>',
      '      <div id="sq-stats-body"><span id="sq-nodes-count">0</span> nodes · <span id="sq-edges-count">0</span> edges</div>',
      '    </section>',
      '    <section class="sq-section" id="sq-streaming">',
      '      <h2>Streaming queue</h2>',
      '      <div id="sq-streaming-queue"></div>',
      '    </section>',
      '    <section class="sq-section" id="sq-details">',
      '      <h2>Details</h2>',
      '      <div id="sq-details-body"><p class="sq-hint">Click a node</p></div>',
      '      <div id="sq-neighbor-list" class="sq-neighbor-list sq-hidden"></div>',
      '    </section>',
      '  </aside>',
      '</div>',
      '<script>',
      COSMOS_BUNDLE,
      '</script>',
      '<script>',
      `const SQ_OPTIONS = ${optionsJson};`,
      `const SQ_WORKER_SRC = ${workerJson};`,
      '</script>',
      '<script>',
      CosmosGraphRenderer.#initScript(),
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  static #css(): string {
    return `
/* Squashage eggplant palette — cosmos.gl renderer. */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; font-family: system-ui, sans-serif; font-size: 14px; background: #0a0a0a; color: #fafafa; }
.sq-header { padding: 8px 16px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; display: flex; align-items: baseline; gap: 12px; }
.sq-header h1 { font-size: 16px; font-weight: 600; color: #c09fef; }
.sq-header .sq-tag { font-size: 11px; color: #707070; opacity: .8; }
.sq-layout { display: flex; height: calc(100vh - 41px); position: relative; }
#cy { flex: 1 1 auto; background: #000000; position: relative; }
#cy canvas { display: block; }
.sq-sidebar { width: 320px; flex: 0 0 320px; overflow-y: auto; background: #111111; border-left: 1px solid #2a2a2a; display: flex; flex-direction: column; }
.sq-section { border-bottom: 1px solid #2a2a2a; padding: 12px; }
.sq-section h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #808080; margin-bottom: 8px; font-weight: 600; }
.sq-hint { color: #707070; font-size: 12px; }
#sq-stats-body { font-size: 12px; color: #c0c0c0; }
#sq-stats-body span { color: #c09fef; font-weight: 600; }
#sq-details-body { font-size: 12px; word-break: break-all; }
.sq-detail-id { color: #e94560; font-weight: 600; margin-bottom: 4px; font-size: 14px; }
.sq-detail-iri { font-family: ui-monospace, monospace; font-size: 10px; color: #707070; margin-bottom: 6px; word-break: break-all; }
.sq-detail-class { color: #c09fef; margin-bottom: 6px; font-size: 12px; }
.sq-detail-prop { margin-bottom: 3px; font-size: 12px; }
.sq-detail-prop-key { color: #c09fef; }
.sq-detail-prop-val { color: #c0c0c0; }
.sq-loading-overlay { position: absolute; inset: 0; background: rgba(10,10,10,0.85); display: flex; flex-direction: column; align-items: center; justify-content: center; z-index: 100; pointer-events: none; }
.sq-loading-overlay.sq-hidden { display: none; }
.sq-spinner { width: 40px; height: 40px; border: 4px solid #2a2a2a; border-top-color: #c09fef; border-radius: 50%; animation: sq-spin 0.8s linear infinite; margin-bottom: 16px; }
@keyframes sq-spin { to { transform: rotate(360deg); } }
.sq-loading-msg { color: #fafafa; font-size: 13px; text-align: center; max-width: 240px; }
.sq-queue-item { font-size: 11px; padding: 3px 4px; border-radius: 3px; margin-bottom: 2px; display: flex; gap: 6px; align-items: baseline; }
.sq-queue-item.sq-queue-done { color: #8fbf7f; }
.sq-queue-item.sq-queue-active { color: #e94560; font-weight: 600; }
.sq-queue-item.sq-queue-pending { color: #707070; }
.sq-queue-status { font-size: 10px; flex: 0 0 auto; }
.sq-queue-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; flex: 0 0 10px; box-shadow: 0 0 0 1px rgba(0,0,0,0.4); }
/* D-pad overlay */
.sq-dpad-wrap { position: absolute; bottom: 20px; right: 20px; z-index: 50; display: flex; flex-direction: column; align-items: center; gap: 4px; pointer-events: auto; }
.sq-zoom-hud { font-family: ui-monospace, monospace; font-size: 11px; color: #c09fef; background: rgba(10,10,10,0.8); padding: 2px 6px; border-radius: 3px; text-align: center; min-width: 48px; }
.sq-dpad { display: grid; grid-template-columns: repeat(3, 32px); grid-template-rows: repeat(3, 32px); gap: 2px; }
.sq-dpad-btn { width: 32px; height: 32px; background: rgba(26,26,26,0.92); color: #c0c0c0; border: 1px solid #333; border-radius: 4px; font-size: 14px; cursor: pointer; display: flex; align-items: center; justify-content: center; transition: background 0.12s; }
.sq-dpad-btn:hover:not(:disabled) { background: rgba(192,159,239,0.25); color: #c09fef; border-color: #c09fef; }
.sq-dpad-btn:active:not(:disabled) { background: rgba(192,159,239,0.45); }
.sq-dpad-btn.sq-dpad-disabled, .sq-dpad-btn:disabled { opacity: 0.3; cursor: not-allowed; }
/* Physics panel */
.sq-physics-panel { position: absolute; bottom: 20px; left: 20px; z-index: 50; background: rgba(17,17,17,0.95); border: 1px solid #2a2a2a; border-radius: 6px; padding: 10px 12px; min-width: 220px; backdrop-filter: blur(8px); }
.sq-physics-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .08em; color: #808080; font-weight: 600; }
.sq-physics-close { background: transparent; border: none; color: #808080; cursor: pointer; font-size: 16px; padding: 0 2px; line-height: 1; }
.sq-physics-close:hover { color: #e94560; }
.sq-physics-row { display: flex; align-items: center; gap: 6px; margin-bottom: 6px; font-size: 11px; color: #a0a0a0; }
.sq-physics-row label { display: flex; flex-direction: column; gap: 2px; flex: 1; }
.sq-physics-row input[type=range] { width: 100%; accent-color: #c09fef; }
.sq-physics-row span { font-family: ui-monospace, monospace; font-size: 10px; color: #c09fef; min-width: 32px; text-align: right; }
.sq-physics-reset { width: 100%; margin-top: 4px; background: rgba(233,69,96,0.15); border: 1px solid #e94560; color: #e94560; border-radius: 4px; padding: 4px 0; font-size: 11px; cursor: pointer; }
.sq-physics-reset:hover { background: rgba(233,69,96,0.3); }
.sq-physics-toggle { margin-left: auto; background: rgba(192,159,239,0.12); border: 1px solid #c09fef; color: #c09fef; border-radius: 4px; padding: 3px 10px; font-size: 11px; cursor: pointer; }
.sq-physics-toggle:hover { background: rgba(192,159,239,0.3); }
/* Neighbor list */
.sq-neighbor-list { max-height: 200px; overflow-y: auto; margin-top: 8px; font-size: 11px; color: #a0a0a0; }
.sq-neighbor-item { padding: 2px 0; border-bottom: 1px solid #1e1e1e; }
.sq-neighbor-item:last-child { border-bottom: none; }
.sq-neighbor-count { color: #c09fef; font-weight: 600; margin-bottom: 4px; font-size: 11px; }
`;
  }

  /**
   * Main-thread init logic, embedded as a plain-JS string (no TS, no imports).
   *
   * Fetches the manifest + meta.json, sizes accumulation buffers, builds the
   * queue UI, then drives the Blob worker. Each `frame` message is absorbed at
   * its global offset and the live prefix is uploaded to cosmos with a warm
   * restart. After streaming completes: meta.json is fetched for IRI/label
   * display, keep-alive simulation interval is started, and the D-pad / physics
   * panel / selection FSM are all wired up.
   */
  static #initScript(): string {
    return `
(function () {
  console.log('[squashage] cosmos init (binary streaming)');

  var CosmosGraph = window.CosmosGraph;
  if (!CosmosGraph) {
    console.error('[squashage] CosmosGraph global missing');
    return;
  }

  // ── DOM handles ─────────────────────────────────────────────────────────
  var container    = document.getElementById('cy');
  var detailsBody  = document.getElementById('sq-details-body');
  var neighborList = document.getElementById('sq-neighbor-list');
  var queueDiv     = document.getElementById('sq-streaming-queue');
  var loadingDiv   = document.getElementById('sq-loading-overlay');
  var loadingMsg   = document.getElementById('sq-loading-msg');
  var nodesCount   = document.getElementById('sq-nodes-count');
  var edgesCount   = document.getElementById('sq-edges-count');
  var zoomHud      = document.getElementById('sq-zoom-hud');
  var physicsPanel = document.getElementById('sq-physics-panel');

  // ── Manifest + accumulation buffers ─────────────────────────────────────
  var manifest     = null;
  var frameMeta    = [];   // per-frame { label, color, nodeCount, nodeBase }
  var queueItems   = [];
  var allPositions = null;
  var allColors    = null;
  var allSizes     = null;
  var allLinks     = null;
  var liveNodes    = 0;
  var liveEdges    = 0;
  var edgeCursor   = 0;    // running write cursor into allLinks (in floats)
  var cosmos       = null;
  var INCREMENTAL_ALPHA = 0.1;

  // ── Feature 2: node metadata from meta.json ──────────────────────────────
  var nodeIris   = [];   // nodeIris[globalIndex] = full IRI string
  var nodeLabels = [];   // nodeLabels[globalIndex] = human label string

  // Neighbor adjacency is read from cosmos.getAdjacentIndices(idx) at click
  // time — cosmos builds it natively from the links we upload, so there is no
  // hand-built client-side adjacency to maintain.

  // ── Feature 4: selection FSM ─────────────────────────────────────────────
  // state: 'idle' | 'nodeSelected'
  var selFsm = { state: 'idle', selectedIdx: -1 };

  function fsmSelectNode(idx) {
    selFsm.state = 'nodeSelected';
    selFsm.selectedIdx = idx;
    if (cosmos !== null) {
      // Highlight the node + its neighbors; cosmos dims the rest. Use the
      // native getAdjacentIndices for the neighbor set so the highlight and
      // the inspector connection list share one source of truth.
      var adj = (typeof cosmos.getAdjacentIndices === 'function' ? cosmos.getAdjacentIndices(idx) : null) || [];
      var highlight = [idx];
      for (var a = 0; a < adj.length; a++) highlight.push(adj[a]);
      cosmos.selectPointsByIndices(highlight);
      cosmos.zoomToPointByIndex(idx, 500, cosmos.getZoomLevel(), false);
    }
    showNodeDetails(idx);
  }

  function fsmClear() {
    selFsm.state = 'idle';
    selFsm.selectedIdx = -1;
    if (cosmos !== null) {
      cosmos.unselectPoints();
    }
    detailsBody.innerHTML = '<p class="sq-hint">Click a node</p>';
    neighborList.innerHTML = '';
    neighborList.classList.add('sq-hidden');
  }

  // Escape key clears selection
  document.addEventListener('keydown', function (ev) {
    if (ev.key === 'Escape') fsmClear();
  });

  // ── Point-size scale via tanh zoom curve ─────────────────────────────────
  function pointSizeScale(zoom) {
    var z = Math.max(0, zoom);
    return 0.6 + 3.4 * Math.tanh(z / 8);
  }

  function buildCosmosConfig(spaceSize) {
    return {
      backgroundColor:               '#000000',
      enableSimulation:              true,
      fitViewOnInit:                 false,
      fitViewDelay:                  0,
      linkDefaultArrows:             false,
      linkOpacity:                   0.8,
      linkVisibilityDistanceRange:   [200, 60],
      linkVisibilityMinTransparency: 0,
      pointGreyoutOpacity:           0.5,
      pointSizeScale:                pointSizeScale(2),
      renderHoveredPointRing:        true,
      hoveredPointRingColor:         '#e94560',
      hoveredLinkColor:              '#e94560',
      hoveredLinkWidthIncrease:      2,
      scalePointsOnZoom:             false,
      spaceSize:                     spaceSize,
      initialZoomLevel:              2,
      // Feature 6: never decay — keep simulation alive indefinitely
      simulationDecay:               100000,
      // Feature 4: selection FSM onClick
      onClick: function (idx) {
        if (idx !== undefined && idx !== null && idx >= 0 && idx < liveNodes) {
          if (selFsm.state === 'nodeSelected' && selFsm.selectedIdx === idx) {
            fsmClear();
          } else {
            fsmSelectNode(idx);
          }
        } else {
          if (selFsm.state === 'nodeSelected') fsmClear();
        }
      },
      // Feature 1: zoom HUD update
      onZoom: function (event) {
        if (cosmos === null) return;
        var k = event && event.transform && event.transform.k ? event.transform.k : cosmos.getZoomLevel();
        cosmos.setConfig({ pointSizeScale: pointSizeScale(k) });
        if (zoomHud !== null) zoomHud.textContent = k.toFixed(2) + '×';
      },
    };
  }

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  // ── Streaming queue UI ──────────────────────────────────────────────────
  function queueItemHtml(state, entry) {
    var icons = { done: '[v]', active: '[>]', pending: '[ ]' };
    return '<span class="sq-queue-status">' + icons[state] + '</span>' +
      '<span class="sq-queue-swatch" style="background:' + esc(entry.color || '#c09fef') + '"></span>' +
      '<span>' + esc(entry.label) + ' (' + entry.nodeCount + ' nodes)</span>';
  }

  function setQueueItemState(i, state) {
    var item = queueItems[i];
    if (!item) return;
    var classes = { done: 'sq-queue-done', active: 'sq-queue-active', pending: 'sq-queue-pending' };
    item.className = 'sq-queue-item ' + classes[state];
    item.innerHTML = queueItemHtml(state, frameMeta[i]);
  }

  function buildQueue() {
    for (var i = 0; i < frameMeta.length; i++) {
      var item = document.createElement('div');
      item.className = 'sq-queue-item sq-queue-pending';
      item.innerHTML = queueItemHtml('pending', frameMeta[i]);
      queueDiv.appendChild(item);
      queueItems.push(item);
    }
  }

  function updateStats() {
    nodesCount.textContent = String(liveNodes);
    edgesCount.textContent = String(liveEdges);
  }

  // ── Feature 2: node details panel with real metadata ─────────────────────
  function frameForNode(globalIdx) {
    for (var i = frameMeta.length - 1; i >= 0; i--) {
      if (globalIdx >= frameMeta[i].nodeBase) return frameMeta[i];
    }
    return null;
  }

  function showNodeDetails(idx) {
    var meta        = frameForNode(idx);
    var iri         = nodeIris[idx]   || '';
    var label       = nodeLabels[idx] || ('Node #' + idx);
    var concept     = meta ? meta.label : '';
    // Connections via the native cosmos adjacency index (authoritative).
    var neighbors   = (cosmos !== null && typeof cosmos.getAdjacentIndices === 'function'
      ? cosmos.getAdjacentIndices(idx)
      : null) || [];
    var neighborCnt = neighbors.length;

    var html = '';
    html += '<div class="sq-detail-id">' + esc(label) + '</div>';
    if (iri)     html += '<div class="sq-detail-iri">'   + esc(iri)     + '</div>';
    if (concept) html += '<div class="sq-detail-class">' + esc(concept) + '</div>';
    html += '<div class="sq-detail-prop"><span class="sq-detail-prop-key">Connections: </span><span class="sq-detail-prop-val">' + neighborCnt + '</span></div>';
    detailsBody.innerHTML = html;

    // Neighbor list (first 20)
    if (neighborCnt > 0) {
      var nlHtml = '<div class="sq-neighbor-count">Neighbors (' + neighborCnt + ')</div>';
      var shown  = Math.min(20, neighborCnt);
      for (var i = 0; i < shown; i++) {
        var nIdx   = neighbors[i];
        var nLabel = nodeLabels[nIdx] || ('Node #' + nIdx);
        nlHtml += '<div class="sq-neighbor-item">' + esc(nLabel) + '</div>';
      }
      if (neighborCnt > 20) nlHtml += '<div class="sq-neighbor-item" style="color:#707070">… and ' + (neighborCnt - 20) + ' more</div>';
      neighborList.innerHTML = nlHtml;
      neighborList.classList.remove('sq-hidden');
    } else {
      neighborList.innerHTML = '';
      neighborList.classList.add('sq-hidden');
    }
  }

  // ── Frame absorption + cosmos upload ────────────────────────────────────
  function absorbFrame(msg) {
    var isFirst   = (liveNodes === 0);
    var nodeBase  = msg.nodeBase;
    var nodeCount = msg.nodeCount;
    var edgeCount = msg.edgeCount;

    // Copy node data into the accumulation buffers at the frame's global offset.
    allPositions.set(msg.positions, nodeBase * 2);
    allColors.set(msg.colors, nodeBase * 4);
    allSizes.set(msg.sizes, nodeBase);

    // Append edges. Endpoints carry GLOBAL indices already — copy each Uint32
    // into the Float32 link buffer (cosmos setLinks wants flat Float32 pairs).
    // cosmos derives its own adjacency index from these links, so we do not
    // maintain a separate client-side map.
    var edges = msg.edges;
    for (var k = 0; k < edges.length; k++) {
      allLinks[edgeCursor++] = edges[k];
    }

    liveNodes = nodeBase + nodeCount;
    liveEdges += edgeCount;

    if (cosmos === null) {
      cosmos = new CosmosGraph(container, buildCosmosConfig(manifest.spaceSize));
    }

    // subarray = zero-copy view of the live prefix, so cosmos never simulates
    // the zero-filled tail of the capacity-sized buffers.
    cosmos.setPointPositions(allPositions.subarray(0, liveNodes * 2));
    cosmos.setPointColors(allColors.subarray(0, liveNodes * 4));
    cosmos.setPointSizes(allSizes.subarray(0, liveNodes));
    cosmos.setLinks(allLinks.subarray(0, liveEdges * 2));

    var alpha = isFirst ? 1 : INCREMENTAL_ALPHA;
    cosmos.render(alpha);
    cosmos.start(alpha);
    cosmos.unpause();

    updateStats();
    setQueueItemState(msg.frameIdx, 'done');
    if (msg.frameIdx + 1 < frameMeta.length) setQueueItemState(msg.frameIdx + 1, 'active');

    loadingMsg.textContent =
      'Streamed ' + (msg.frameIdx + 1) + ' of ' + frameMeta.length + ': ' +
      msg.label + ' — ' + nodeCount + ' nodes';
    console.log('[squashage] frame ' + (msg.frameIdx + 1) + '/' + frameMeta.length +
      ' absorbed: ' + msg.label + ' (+nodes=' + nodeCount + ' +edges=' + edgeCount + ')');
  }

  // ── Feature 6: keep-alive simulation interval ────────────────────────────
  // cosmos.gl re-energizes the layout via start(alpha). Re-energizing at a low
  // alpha on a 2s cadence (matching cartographus' SimulationAlphaRefresh) keeps
  // the layout drifting continuously instead of freezing.
  function startKeepAlive() {
    cosmos.setConfig({ simulationDecay: 100000 });
    setInterval(function () {
      if (cosmos !== null) cosmos.start(0.1);
    }, 2000);
  }

  // ── Feature 2: load meta.json.gz after streaming completes ───────────────
  // The metadata sidecar is shipped gzip-compressed (~2.5 MB vs ~41 MB raw)
  // and decoded in-browser with the native DecompressionStream. No build step
  // or server gzip negotiation is required — it works on plain GitHub Pages.
  function applyMeta(data) {
    if (data.format === 'squashage-node-meta-v2') {
      // v2: prefix-compressed — reconstruct full IRIs from prefix table + local names.
      var prefixes = data.prefixes || [];
      var pIdx     = data.pIdx     || [];
      var locals   = data.locals   || [];
      nodeLabels   = data.labels   || [];
      nodeIris     = [];
      for (var i = 0; i < locals.length; i++) {
        var pi = pIdx[i];
        nodeIris.push(pi >= 0 && pi < prefixes.length ? prefixes[pi] + locals[i] : locals[i]);
      }
    } else {
      // v1: plain arrays (fallback for older sidecars)
      nodeIris   = data.iris    || [];
      nodeLabels = data.labels  || [];
    }
    console.log('[squashage] meta loaded: ' + nodeIris.length + ' entries');
  }

  function loadMeta(baseUrl) {
    var gzUrl = baseUrl.replace(/manifest[.]json([?#].*)?$/, 'meta.json.gz');
    fetch(gzUrl)
      .then(function (r) {
        if (!r.ok) throw new Error('meta.json.gz ' + r.status);
        if (typeof DecompressionStream === 'undefined' || r.body === null) {
          // No streaming decompression available — fall back to a raw meta.json.
          throw new Error('no-decompression-stream');
        }
        var stream = r.body.pipeThrough(new DecompressionStream('gzip'));
        return new Response(stream).json();
      })
      .then(applyMeta)
      .catch(function (err) {
        // Fallback path: try an uncompressed meta.json (older demos / no DecompressionStream).
        var rawUrl = baseUrl.replace(/manifest[.]json([?#].*)?$/, 'meta.json');
        fetch(rawUrl)
          .then(function (r) { if (!r.ok) throw new Error('meta.json ' + r.status); return r.json(); })
          .then(applyMeta)
          .catch(function (err2) {
            console.warn('[squashage] meta unavailable:', String((err && err.message) || err),
              '/', String((err2 && err2.message) || err2));
          });
      });
  }

  // ── Worker plumbing (transferable ArrayBuffer; no SharedArrayBuffer) ─────
  function startWorker(manifestUrl, baseUrl) {
    var blob   = new Blob([SQ_WORKER_SRC], { type: 'application/javascript' });
    var worker = new Worker(URL.createObjectURL(blob));

    worker.onmessage = function (ev) {
      var msg = ev.data;
      if (msg.type === 'frame') {
        absorbFrame(msg);
      } else if (msg.type === 'complete') {
        loadingDiv.classList.add('sq-hidden');
        console.log('[squashage] streaming complete: nodes=' + msg.totalNodes + ' edges=' + msg.totalEdges);
        if (cosmos !== null) {
          cosmos.fitView(600);
          startKeepAlive();
        }
        loadMeta(baseUrl);
        worker.terminate();
      } else if (msg.type === 'error') {
        console.error('[squashage] worker error:', msg.error);
        loadingDiv.classList.remove('sq-hidden');
        loadingMsg.textContent = 'Streaming error: ' + String(msg.error);
      }
    };

    worker.onerror = function (err) {
      console.error('[squashage] worker fatal:', err);
      loadingDiv.classList.remove('sq-hidden');
      loadingMsg.textContent = 'Worker error: ' + String(err.message || err);
    };

    worker.postMessage({ cmd: 'start', manifestUrl: manifestUrl, baseUrl: baseUrl });
  }

  // ── Feature 1: D-pad navigation ──────────────────────────────────────────
  function wireButton(id, fn) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('click', fn);
  }

  wireButton('sq-btn-zoom-in', function () {
    if (cosmos === null) return;
    cosmos.setZoomLevel(cosmos.getZoomLevel() * 1.4, 250);
  });
  wireButton('sq-btn-zoom-out', function () {
    if (cosmos === null) return;
    cosmos.setZoomLevel(cosmos.getZoomLevel() / 1.4, 250);
  });
  // Pan: cosmos.gl 2.6.4 exposes no first-class pan API (no camera-translate
  // setter). Following GraphDpad.vue's panEnabled=false contract, the pan
  // buttons are rendered disabled rather than wired to a missing method.
  // Drag-to-pan on the canvas itself still works via cosmos' built-in d3-zoom.
  wireButton('sq-btn-centre', function () {
    if (cosmos === null) return;
    if (selFsm.state === 'nodeSelected' && selFsm.selectedIdx >= 0) {
      cosmos.zoomToPointByIndex(selFsm.selectedIdx, 500, cosmos.getZoomLevel(), false);
    } else {
      cosmos.fitView(600);
    }
  });
  wireButton('sq-btn-fit', function () {
    if (cosmos === null) return;
    cosmos.fitView(600);
  });
  wireButton('sq-btn-fullscreen', function () {
    if (!document.fullscreenElement) {
      container.requestFullscreen && container.requestFullscreen();
    } else {
      document.exitFullscreen && document.exitFullscreen();
    }
  });

  // ── Feature 5: Physics panel ─────────────────────────────────────────────
  var PHYSICS_DEFAULTS = {
    gravity:    1,
    repulsion:  1,
    spring:     1,
    dist:       10,
    friction:   0.1,
    decay:      100000,
  };

  function applyPhysics() {
    if (cosmos === null) return;
    var g   = parseFloat(document.getElementById('sq-phys-gravity').value);
    var rep = parseFloat(document.getElementById('sq-phys-repulsion').value);
    var spr = parseFloat(document.getElementById('sq-phys-spring').value);
    var dst = parseFloat(document.getElementById('sq-phys-dist').value);
    var fri = parseFloat(document.getElementById('sq-phys-friction').value);
    var decRaw = parseFloat(document.getElementById('sq-phys-decay').value);
    // At the slider's max the decay reads ∞ — map it to the never-cool sentinel
    // so moving any slider does not accidentally re-enable settling.
    var dec = (decRaw >= 10000) ? 100000 : decRaw;
    cosmos.setConfig({
      simulationGravity:      g,
      simulationRepulsion:    rep,
      simulationLinkSpring:   spr,
      simulationLinkDistance: dst,
      simulationFriction:     fri,
      simulationDecay:        dec,
    });
    // cosmos.gl re-energizes the layout via start(alpha).
    cosmos.start(0.2);
  }

  function updatePhysicsVal(id, valId, suffix) {
    var el  = document.getElementById(id);
    var val = document.getElementById(valId);
    if (!el || !val) return;
    el.addEventListener('input', function () {
      val.textContent = suffix ? String(Math.round(parseFloat(el.value))) : el.value;
      applyPhysics();
    });
  }

  updatePhysicsVal('sq-phys-gravity',   'sq-phys-gravity-val',   false);
  updatePhysicsVal('sq-phys-repulsion', 'sq-phys-repulsion-val', false);
  updatePhysicsVal('sq-phys-spring',    'sq-phys-spring-val',    false);
  updatePhysicsVal('sq-phys-dist',      'sq-phys-dist-val',      true);
  updatePhysicsVal('sq-phys-friction',  'sq-phys-friction-val',  false);
  // Decay slider val shows infinity symbol when at max (keep-alive)
  var decSlider = document.getElementById('sq-phys-decay');
  var decVal    = document.getElementById('sq-phys-decay-val');
  if (decSlider && decVal) {
    decSlider.addEventListener('input', function () {
      var v = parseFloat(decSlider.value);
      decVal.textContent = (v >= 10000) ? '∞' : String(v);
      applyPhysics();
    });
  }

  var physicsResetBtn = document.getElementById('sq-physics-reset');
  if (physicsResetBtn) {
    physicsResetBtn.addEventListener('click', function () {
      var setSlider = function (id, valId, value, label) {
        var el = document.getElementById(id);
        var vl = document.getElementById(valId);
        if (el) el.value = String(value);
        if (vl) vl.textContent = label !== undefined ? label : String(value);
      };
      setSlider('sq-phys-gravity',   'sq-phys-gravity-val',   PHYSICS_DEFAULTS.gravity,   undefined);
      setSlider('sq-phys-repulsion', 'sq-phys-repulsion-val', PHYSICS_DEFAULTS.repulsion, undefined);
      setSlider('sq-phys-spring',    'sq-phys-spring-val',    PHYSICS_DEFAULTS.spring,    undefined);
      setSlider('sq-phys-dist',      'sq-phys-dist-val',      PHYSICS_DEFAULTS.dist,      undefined);
      setSlider('sq-phys-friction',  'sq-phys-friction-val',  PHYSICS_DEFAULTS.friction,  undefined);
      setSlider('sq-phys-decay',     'sq-phys-decay-val',     PHYSICS_DEFAULTS.decay,     '∞');
      applyPhysics();
    });
  }

  var physicsCloseBtn   = document.getElementById('sq-physics-close');
  var physicsToggleBtn  = document.getElementById('sq-physics-toggle');
  if (physicsCloseBtn) {
    physicsCloseBtn.addEventListener('click', function () {
      physicsPanel.classList.add('sq-hidden');
    });
  }
  if (physicsToggleBtn) {
    physicsToggleBtn.addEventListener('click', function () {
      physicsPanel.classList.toggle('sq-hidden');
    });
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────
  var manifestUrl = SQ_OPTIONS.indexUrl;
  var baseUrl = new URL(manifestUrl, document.baseURI).href;
  console.log('[squashage] fetching manifest: ' + manifestUrl);
  loadingDiv.classList.remove('sq-hidden');
  loadingMsg.textContent = 'Loading manifest…';

  fetch(manifestUrl)
    .then(function (r) { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
    .then(function (data) {
      manifest = data;
      frameMeta = data.frames.map(function (f) {
        return { label: f.label, color: f.color, nodeCount: f.nodeCount, nodeBase: f.nodeBase };
      });
      console.log('[squashage] manifest loaded: ' + frameMeta.length + ' frames, ' +
        data.totalNodes + ' nodes, ' + data.totalEdges + ' edges');

      allPositions = new Float32Array(data.totalNodes * 2);
      allColors    = new Float32Array(data.totalNodes * 4);
      allSizes     = new Float32Array(data.totalNodes);
      allLinks     = new Float32Array(data.totalEdges * 2);

      buildQueue();
      if (frameMeta.length > 0) setQueueItemState(0, 'active');

      startWorker(baseUrl, baseUrl);
    })
    .catch(function (err) {
      console.error('[squashage] manifest error:', err);
      loadingDiv.classList.remove('sq-hidden');
      loadingMsg.textContent = 'Cannot load manifest: ' + String(err.message || err);
    });

  // Expose diagnostic handle.
  window.__sq = {
    cosmos:       function () { return cosmos; },
    manifest:     function () { return manifest; },
    liveNodes:    function () { return liveNodes; },
    liveEdges:    function () { return liveEdges; },
    nodeIris:     function () { return nodeIris; },
    nodeLabels:   function () { return nodeLabels; },
    adjMap:       function () { return adjMap; },
    showNode:     showNodeDetails,
    clearSel:     fsmClear,
  };
})();
`;
  }

  /**
   * Worker logic, embedded as a plain-JS string and instantiated via Blob URL.
   *
   * Re-fetches the manifest, then for each frame fetches the `.bin`, validates
   * the `0x53514247` magic + version via `DataView`, copies the four typed-array
   * regions into fresh `ArrayBuffer`s, and posts each frame transferring those
   * buffers (the second `postMessage` argument is the transfer list — not a
   * `SharedArrayBuffer`).
   */
  static #workerScript(): string {
    return `
'use strict';
var FRAME_MAGIC = 0x53514247;
var FRAME_VERSION = 1;
var FRAME_HEADER_BYTES = 16;

self.onmessage = function (ev) {
  var msg = ev.data;
  if (!msg || msg.cmd !== 'start') return;
  streamFrames(msg.manifestUrl, msg.baseUrl);
};

function fail(error) {
  self.postMessage({ type: 'error', error: String(error && error.message ? error.message : error) });
}

function streamFrames(manifestUrl, baseUrl) {
  fetch(manifestUrl)
    .then(function (r) { if (!r.ok) throw new Error('manifest ' + r.status); return r.json(); })
    .then(function (manifest) {
      var frames = manifest.frames || [];
      return frames.reduce(function (chain, frame, frameIdx) {
        return chain.then(function () { return streamOne(frame, frameIdx, baseUrl); });
      }, Promise.resolve()).then(function () {
        self.postMessage({ type: 'complete', totalNodes: manifest.totalNodes, totalEdges: manifest.totalEdges });
      });
    })
    .catch(fail);
}

function streamOne(frame, frameIdx, baseUrl) {
  var frameUrl = new URL(frame.file, baseUrl).href;
  return fetch(frameUrl)
    .then(function (r) { if (!r.ok) throw new Error('frame ' + frame.file + ': ' + r.status); return r.arrayBuffer(); })
    .then(function (buf) {
      var view = new DataView(buf);
      var magic = view.getUint32(0, true);
      if (magic !== FRAME_MAGIC) throw new Error('bad magic in ' + frame.file + ': 0x' + magic.toString(16));
      var version = view.getUint32(4, true);
      if (version !== FRAME_VERSION) throw new Error('bad version in ' + frame.file + ': ' + version);
      var nodeCount = view.getUint32(8, true);
      var edgeCount = view.getUint32(12, true);

      var off = FRAME_HEADER_BYTES;

      // Copy each region into a fresh ArrayBuffer so it detaches from the frame
      // buffer and can be transferred (true zero-copy hand-off to the main thread).
      var posBytes = nodeCount * 2 * 4;
      var positions = new Float32Array(buf.slice(off, off + posBytes));
      off += posBytes;

      var colBytes = nodeCount * 4 * 4;
      var colors = new Float32Array(buf.slice(off, off + colBytes));
      off += colBytes;

      var sizeBytes = nodeCount * 4;
      var sizes = new Float32Array(buf.slice(off, off + sizeBytes));
      off += sizeBytes;

      var edgeBytes = edgeCount * 2 * 4;
      var edges = new Uint32Array(buf.slice(off, off + edgeBytes));
      off += edgeBytes;

      self.postMessage({
        type:      'frame',
        frameIdx:  frameIdx,
        label:     frame.label,
        color:     frame.color,
        nodeCount: nodeCount,
        edgeCount: edgeCount,
        nodeBase:  frame.nodeBase,
        positions: positions,
        colors:    colors,
        sizes:     sizes,
        edges:     edges,
      }, [positions.buffer, colors.buffer, sizes.buffer, edges.buffer]);
    });
}
`;
  }
}
