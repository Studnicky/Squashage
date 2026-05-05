/**
 * @fileoverview SigmaGraphRenderer — emits the small HTML wrapper that loads
 * the sigma+graphology bundle and progressively merges chunked graph data.
 * @module viz/SigmaGraphRenderer
 *
 * The wrapper is a single ~170KB HTML file (sigma+graphology vendored inline,
 * eggplant CSS, init script). At runtime it fetches `index.json`, then each
 * chunk in ascending-size order, deserialising each into the graphology Graph
 * and letting Sigma re-render incrementally. Chunks carry pre-computed
 * positions baked in by `ChunkBuilder` at build time, so there is no layout
 * cost in the browser.
 */
import { SIGMA_BUNDLE } from './vendor/sigmaBundle.js';

/**
 * Options for `SigmaGraphRenderer.render()`.
 *
 * @category Viz
 * @since 0.2.0
 * @group Types
 */
export interface SigmaRenderOptionsInterface {
  /** HTML page title. Default: `'Squashage Graph'`. */
  readonly title?:    string;
  /** Path (relative or absolute URL) to `index.json`. Default: `'./index.json'`. */
  readonly indexUrl?: string;
}

/**
 * Static-only renderer that emits the standalone HTML wrapper. The runtime
 * payload (`index.json` + `chunks/*.json`) is produced separately by
 * `ChunkBuilder` and must sit alongside the HTML.
 *
 * @category Viz
 * @since 0.2.0
 * @group Core
 */
export class SigmaGraphRenderer {
  private constructor() { /* static-only */ }

  /** Renders the standalone HTML wrapper. */
  static render(opts: SigmaRenderOptionsInterface = {}): string {
    const title    = opts.title    ?? 'Squashage Graph';
    const indexUrl = opts.indexUrl ?? './index.json';
    return SigmaGraphRenderer.#html(title, indexUrl);
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
    const initJson = JSON.stringify({ indexUrl });
    return [
      '<!DOCTYPE html>',
      '<html lang="en">',
      '<head>',
      '<meta charset="UTF-8">',
      '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
      `<title>${SigmaGraphRenderer.#esc(title)}</title>`,
      '<style>',
      SigmaGraphRenderer.#css(),
      '</style>',
      '</head>',
      '<body>',
      `<header class="sq-header"><h1>${SigmaGraphRenderer.#esc(title)}</h1><span class="sq-tag">streaming • sigma webgl • forceatlas2</span></header>`,
      '<div class="sq-layout">',
      '  <div id="cy"></div>',
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
      '      <h2>Streaming</h2>',
      '      <div id="sq-streaming-controls">',
      '        <button id="sq-pause-btn" class="sq-btn">Pause</button>',
      '      </div>',
      '      <div id="sq-streaming-queue"></div>',
      '    </section>',
      '    <section class="sq-section" id="sq-details">',
      '      <h2>Details</h2>',
      '      <div id="sq-details-body"><p class="sq-hint">Click a node</p></div>',
      '    </section>',
      '  </aside>',
      '</div>',
      '<script>',
      SIGMA_BUNDLE,
      '</script>',
      '<script>',
      `const SQ_OPTIONS = ${initJson};`,
      '</script>',
      '<script>',
      SigmaGraphRenderer.#initScript(),
      '</script>',
      '</body>',
      '</html>',
    ].join('\n');
  }

  static #css(): string {
    return `
/* Squashage eggplant palette — matches docs/.vitepress/theme/palette.css (dark). */
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body { height: 100%; font-family: system-ui, sans-serif; font-size: 14px; background: #0a0a0a; color: #fafafa; }
.sq-header { padding: 8px 16px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; display: flex; align-items: baseline; gap: 12px; }
.sq-header h1 { font-size: 16px; font-weight: 600; color: #c09fef; }
.sq-header .sq-tag { font-size: 11px; color: #707070; opacity: .8; }
.sq-layout { display: flex; height: calc(100vh - 41px); position: relative; }
#cy { flex: 1 1 auto; background: #0a0a0a; position: relative; }
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
#sq-streaming-controls { margin-bottom: 8px; }
.sq-btn { background: #1a1a1a; color: #fafafa; border: 1px solid #c09fef; border-radius: 4px; padding: 4px 12px; font-size: 12px; cursor: pointer; }
.sq-btn:hover { background: rgba(192, 159, 239, 0.12); }
.sq-queue-item { font-size: 11px; padding: 3px 4px; border-radius: 3px; margin-bottom: 2px; display: flex; gap: 6px; align-items: baseline; }
.sq-queue-item.sq-queue-done { color: #8fbf7f; }
.sq-queue-item.sq-queue-active { color: #e94560; font-weight: 600; }
.sq-queue-item.sq-queue-pending { color: #707070; }
.sq-queue-status { font-size: 10px; flex: 0 0 auto; }
.sq-queue-swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; flex: 0 0 10px; box-shadow: 0 0 0 1px rgba(0,0,0,0.4); }
`;
  }

  static #initScript(): string {
    return `
(function () {
  console.log('[squashage] init; document.hidden=' + document.hidden);

  var Graph = window.Graphology;
  var Sigma = window.Sigma;
  if (!Graph || !Sigma) {
    console.error('[squashage] graphology/sigma globals missing');
    return;
  }

  var graph     = new Graph({ multi: true, type: 'directed' });
  var container = document.getElementById('cy');

  // Custom label renderer — adds dark text-stroke so labels stay legible
  // against any cluster color or the canvas. Sigma 3 calls this per visible
  // label every frame; cheap because <40 labels are ever drawn.
  function drawLabelWithStroke(context, data, settings) {
    if (!data.label) return;
    var size  = settings.labelSize  || 13;
    var font  = settings.labelFont  || 'system-ui, sans-serif';
    var weight = settings.labelWeight || '600';
    context.font = weight + ' ' + size + 'px ' + font;
    var x = data.x + data.size + 4;
    var y = data.y + size / 3;
    // Dark halo: stroke the text twice with the canvas color, then fill.
    context.lineJoin = 'round';
    context.miterLimit = 2;
    context.strokeStyle = '#0a0a0a';
    context.lineWidth = 4;
    context.strokeText(data.label, x, y);
    context.fillStyle = '#fafafa';
    context.fillText(data.label, x, y);
  }
  function drawHoverWithStroke(context, data, settings) {
    drawLabelWithStroke(context, data, settings);
  }

  // Settings — sigma.js storybook large-graphs reference + halo labels.
  var sigma = new Sigma(graph, container, {
    renderLabels:               true,
    renderEdgeLabels:           false,
    hideEdgesOnMove:            false,
    hideLabelsOnMove:           false,
    labelColor:                 { color: '#fafafa' },
    labelDensity:               0.07,
    labelGridCellSize:          60,
    labelRenderedSizeThreshold: 12,
    labelFont:                  'system-ui, sans-serif',
    labelSize:                  13,
    labelWeight:                '600',
    edgeColor:                  'attribute',
    defaultEdgeColor:           '#222222',
    defaultNodeColor:           '#c09fef',
    minCameraRatio:             0.02,
    maxCameraRatio:             40,
    defaultEdgeType:            'line',
    zIndex:                     true,
    defaultDrawNodeLabel:       drawLabelWithStroke,
    defaultDrawNodeHover:       drawHoverWithStroke,
  });

  // Hue-shift the node's chunk color toward the rose accent without replacing
  // it. Sigma 3's circle program respects whatever hex we return, and shift
  // amounts are deliberately small (~+12% saturation, +8% lightness shift).
  function hexToRgb(hex) {
    if (!hex || hex.charAt(0) !== '#' || hex.length !== 7) return null;
    return {
      r: parseInt(hex.substr(1, 2), 16),
      g: parseInt(hex.substr(3, 2), 16),
      b: parseInt(hex.substr(5, 2), 16),
    };
  }
  function rgbToHex(r, g, b) {
    function h(n) { var s = Math.max(0, Math.min(255, Math.round(n))).toString(16); return s.length === 1 ? '0' + s : s; }
    return '#' + h(r) + h(g) + h(b);
  }
  // Mix base color toward target by t in [0..1]. At t=0.25 the hue noticeably
  // warms toward rose without losing the chunk identity.
  function mix(base, target, t) {
    var a = hexToRgb(base); var b = hexToRgb(target);
    if (!a || !b) return base;
    return rgbToHex(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t);
  }
  var ROSE = '#e94560';

  // Hover/select reducers — same size; ONLY shift hue + add a glow/halo on
  // the focus node and its neighbours. Non-incident edges still hide so the
  // neighbourhood is legible.
  var hoveredNode = null;
  var selectedNode = null;
  function focusNode() { return selectedNode || hoveredNode; }

  sigma.setSetting('nodeReducer', function (node, data) {
    var d = Object.assign({}, data);
    var focus = focusNode();
    if (!focus) return d;
    if (node === focus) {
      d.color = mix(data.color || '#c09fef', ROSE, 0.45);
      d.zIndex = 2;
      d.highlighted = true; // sigma renders the hover halo for highlighted nodes
    } else if (graph.hasEdge(node, focus) || graph.hasEdge(focus, node)) {
      d.color = mix(data.color || '#c09fef', ROSE, 0.20);
      d.zIndex = 1;
    } else {
      d.color = mix(data.color || '#c09fef', '#0a0a0a', 0.65);
      d.label = '';
      d.zIndex = 0;
    }
    return d;
  });
  sigma.setSetting('edgeReducer', function (edge, data) {
    var d = Object.assign({}, data);
    var focus = focusNode();
    if (!focus) return d;
    if (graph.hasExtremity(edge, focus)) {
      d.color  = mix(data.color || '#222222', ROSE, 0.6);
      d.zIndex = 1;
    } else {
      d.hidden = true;
    }
    return d;
  });

  sigma.on('enterNode', function (e) { hoveredNode = e.node; sigma.refresh(); });
  sigma.on('leaveNode', function () { hoveredNode = null; sigma.refresh(); });

  // Diagnostic handles for headless inspection. Cheap to keep.
  window.__sq = {
    sigma:  sigma,
    graph:  graph,
    setHover:  function (id) { hoveredNode = id; sigma.refresh(); },
    setSelect: function (id) { selectedNode = id; sigma.refresh(); },
  };

  var detailsBody = document.getElementById('sq-details-body');

  function esc(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function showNodeDetails(nodeId) {
    if (!graph.hasNode(nodeId)) return;
    var attrs = graph.getNodeAttributes(nodeId);
    var html = '';
    html += '<div class="sq-detail-id">' + esc(attrs.label || nodeId) + '</div>';
    if (nodeId !== attrs.label) html += '<div class="sq-detail-iri">' + esc(nodeId) + '</div>';
    if (attrs.classLabel) html += '<div class="sq-detail-class">' + esc(attrs.classLabel) + '</div>';
    var props = attrs.properties || {};
    var keys = Object.keys(props).sort();
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      var vals = props[k];
      for (var j = 0; j < vals.length; j++) {
        html += '<div class="sq-detail-prop"><span class="sq-detail-prop-key">' + esc(k) + ': </span><span class="sq-detail-prop-val">' + esc(String(vals[j])) + '</span></div>';
      }
    }
    detailsBody.innerHTML = html;
  }

  sigma.on('clickNode', function (e) {
    selectedNode = e.node;
    showNodeDetails(e.node);
    sigma.refresh();
  });
  sigma.on('clickStage', function () {
    selectedNode = null;
    detailsBody.innerHTML = '<p class="sq-hint">Click a node</p>';
    sigma.refresh();
  });

  // ---- Streaming UI ----
  var queueDiv     = document.getElementById('sq-streaming-queue');
  var pauseBtn     = document.getElementById('sq-pause-btn');
  var loadingDiv   = document.getElementById('sq-loading-overlay');
  var loadingMsg   = document.getElementById('sq-loading-msg');
  var nodesCount   = document.getElementById('sq-nodes-count');
  var edgesCount   = document.getElementById('sq-edges-count');
  var queueItems   = [];

  var streaming = { paused: false, index: 0, total: 0, manifest: [] };

  pauseBtn.addEventListener('click', function () {
    streaming.paused = !streaming.paused;
    pauseBtn.textContent = streaming.paused ? 'Resume' : 'Pause';
    if (!streaming.paused) loadNextChunk();
  });

  function setQueueItemState(i, state) {
    var item = queueItems[i];
    if (!item) return;
    var entry = streaming.manifest[i];
    var icons   = { done: '[v]', active: '[>]', pending: '[ ]' };
    var classes = { done: 'sq-queue-done', active: 'sq-queue-active', pending: 'sq-queue-pending' };
    item.className = 'sq-queue-item ' + classes[state];
    item.innerHTML =
      '<span class="sq-queue-status">' + icons[state] + '</span>' +
      '<span class="sq-queue-swatch" style="background:' + esc(entry.color || '#c09fef') + '"></span>' +
      '<span>' + esc(entry.label) + ' (' + entry.nodeCount + ' nodes)</span>';
  }

  function updateStats() {
    nodesCount.textContent = String(graph.order);
    edgesCount.textContent = String(graph.size);
  }

  function loadNextChunk() {
    if (streaming.paused) return;
    if (streaming.index >= streaming.total) {
      loadingDiv.classList.add('sq-hidden');
      console.log('[squashage] streaming complete: nodes=' + graph.order + ' edges=' + graph.size);
      return;
    }

    var idx   = streaming.index;
    var entry = streaming.manifest[idx];

    setQueueItemState(idx, 'active');
    loadingDiv.classList.remove('sq-hidden');
    loadingMsg.textContent =
      'Loading ' + (idx + 1) + ' of ' + streaming.total + ': ' +
      entry.label + ' — ' + entry.nodeCount + ' nodes';
    console.log('[squashage] fetch chunk ' + (idx + 1) + '/' + streaming.total + ': ' + entry.file);

    fetch(entry.file)
      .then(function (r) { if (!r.ok) throw new Error('fetch ' + entry.file + ': ' + r.status); return r.json(); })
      .then(function (chunk) {
        // Add nodes (skip duplicates — chunks may share boundary nodes).
        for (var i = 0; i < chunk.nodes.length; i++) {
          var n = chunk.nodes[i];
          if (graph.hasNode(n.id)) continue;
          graph.addNode(n.id, {
            x:           n.x,
            y:           n.y,
            // Size baked at build time (degree/3, capped 2-20).
            size:        n.size || 4,
            color:       n.color,
            label:       n.label,
            classIri:    n.classIri,
            classLabel:  n.classLabel,
            properties:  n.properties,
          });
        }
        // Add edges.
        for (var j = 0; j < chunk.edges.length; j++) {
          var e = chunk.edges[j];
          if (!graph.hasNode(e.source) || !graph.hasNode(e.target)) continue;
          if (graph.hasEdge(e.id)) continue;
          graph.addEdgeWithKey(e.id, e.source, e.target, {
            label: e.label,
            color: e.color,
            size:  0.4,
          });
        }

        sigma.refresh();
        updateStats();
        setQueueItemState(idx, 'done');
        streaming.index++;
        console.log('[squashage] chunk done: ' + entry.label + ' (' + (idx + 1) + '/' + streaming.total + '); +nodes=' + chunk.nodes.length + ' +edges=' + chunk.edges.length);
        // setTimeout (not rAF) so the streaming continues in hidden tabs.
        setTimeout(loadNextChunk, 0);
      })
      .catch(function (err) {
        console.error('[squashage] chunk error:', err);
        loadingMsg.textContent = 'Error loading ' + entry.label + ': ' + String(err.message || err);
      });
  }

  // ---- Bootstrap: fetch index.json, populate queue UI, start ----
  console.log('[squashage] fetching index: ' + SQ_OPTIONS.indexUrl);
  fetch(SQ_OPTIONS.indexUrl)
    .then(function (r) { if (!r.ok) throw new Error('index ' + r.status); return r.json(); })
    .then(function (idx) {
      streaming.manifest = idx.chunks;
      streaming.total    = idx.chunks.length;
      console.log('[squashage] index loaded: ' + streaming.total + ' chunks');

      idx.chunks.forEach(function (entry) {
        var item = document.createElement('div');
        item.className = 'sq-queue-item sq-queue-pending';
        item.innerHTML =
          '<span class="sq-queue-status">[ ]</span>' +
          '<span class="sq-queue-swatch" style="background:' + esc(entry.color || '#c09fef') + '"></span>' +
          '<span>' + esc(entry.label) + ' (' + entry.nodeCount + ' nodes)</span>';
        queueDiv.appendChild(item);
        queueItems.push(item);
      });

      setTimeout(loadNextChunk, 0);
    })
    .catch(function (err) {
      console.error('[squashage] index error:', err);
      loadingDiv.classList.remove('sq-hidden');
      loadingMsg.textContent = 'Cannot load index: ' + String(err.message || err);
    });
})();
`;
  }
}
