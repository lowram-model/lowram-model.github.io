"use strict";

// Presentation layer adapted from the existing LowRAM website.
// Recorded benchmark values are loaded unchanged; this file does not run inference.
const $ = (id) => document.getElementById(id);
const names = {baseline: "Uncompressed", lowram: "LowRAM · full adaptation", fast: "LowRAM · meta-init + selective"};
const colors = {"LowRAM": "#b5412a", "LowRAM-EQ": "#2f6db3", "Quantisation": "#9a7b00", "Eviction": "#d17fa6", "Uncompressed": "#8a8780", "LowRAM-SR": "#b5412a"};
const TARGET_RATIO = 4;
const DATA_REF = "9a65587ade2e9d90d31d33b7e186cad99d34b831";
const DATA_REPO = "lowram-model/lowram-model.github.io";
let CONTEXT_TOKENS = null;
let report = null;
let paper = null;
let archive = null;
const text = (id, value) => { const el = $(id); if (el) el.textContent = value; };
const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : "—";
const pct = (value) => Number.isFinite(value) ? `${number(value * 100)}%` : "—";
const bytes = (value) => Number.isFinite(value) ? (value >= 2 ** 30 ? `${number(value / 2 ** 30, 2)} GiB` : `${number(value / 2 ** 20)} MiB`) : "—";
const elem = (tag, value, className) => {
  const el = document.createElement(tag);
  if (value !== undefined) el.textContent = value;
  if (className) el.className = className;
  return el;
};
const distinct = (items) => [...new Set(items)].sort((a, b) => typeof a === "number" ? a - b : 0);

function selectOptions(id, values, label = String) {
  const el = $(id), previous = el.value;
  el.replaceChildren(...values.map((v) => {
    const option = elem("option", label(v)); option.value = v; return option;
  }));
  if (values.some((v) => String(v) === previous)) el.value = previous;
  el.disabled = !values.length;
}

function validate(data) {
  if (data.schema_version !== 1 || data.kind !== "lowram_comparison" || !data.metadata?.model ||
      !Array.isArray(data.examples) || !Array.isArray(data.comparisons) || !data.examples.length || !data.comparisons.length) {
    throw new Error("Use a JSON export from python -m benchmarks.compare (schema version 1).");
  }
  for (const example of data.examples) {
    if (typeof example.id !== "string" || !["string", "undefined"].includes(typeof example.document) || typeof example.question !== "string" ||
        !Array.isArray(example.references) || !example.references.length || !example.references.every(v => typeof v === "string") ||
        !Number.isFinite(example.context_tokens)) throw new Error("Invalid document or references in the run.");
  }
  for (const row of data.comparisons) {
    if (!Object.hasOwn(names, row.method) || !["ok", "oom"].includes(row.status) ||
        ![row.context_tokens, row.batch_size, row.target_ratio].every(v => Number.isFinite(v) && v > 0)) throw new Error("Invalid comparison settings.");
    if (row.status === "ok" && (!row.summary?.accuracy || !Array.isArray(row.runs) ||
        !row.summary.physical_compressed_bytes || !row.summary.decode_tokens_per_s || !row.summary.ttft_s)) throw new Error("A completed comparison is missing metrics.");
    if (row.status === "ok" && row.runs.some(run => !Array.isArray(run.answers) ||
        run.answers.some(a => typeof a.answer !== "string" || typeof a.example_id !== "string"))) throw new Error("Invalid recorded answers.");
  }
  if (!data.examples.some(e => typeof e.document === "string")) throw new Error("The run has no saved document.");
  if (!data.comparisons.some(r => r.method === "baseline") || !data.comparisons.some(r => r.method !== "baseline")) {
    throw new Error("Include both baseline and a LowRAM configuration in your benchmark.");
  }
  return data;
}

function acceptReport(data) {
  report = validate(data);
  const contexts = distinct(report.comparisons.map(r => r.context_tokens));
  if (contexts.length !== 1 || report.comparisons.some(r => r.method !== "baseline" && r.target_ratio !== TARGET_RATIO)) {
    throw new Error("The demo requires a single context length and a 4× target compression ratio.");
  }
  CONTEXT_TOKENS = contexts[0];
  $("load-error").hidden = true;
  text("run-label", "Recorded run");
  text("run-model", report.metadata.model.split("/").pop());
  text("run-hardware", `GPU: ${report.metadata.gpu || "not recorded in this export"}`);
  document.querySelectorAll(".context-label").forEach(el => { el.textContent = `${Math.round(CONTEXT_TOKENS / 1024)}K`; });
  selectOptions("method-select", distinct(report.comparisons.filter(r => r.method !== "baseline").map(r => r.method)), v => names[v]);
  if (report.comparisons.some(r => r.method === "fast")) $("method-select").value = "fast";
  updateControls("initial");
}

function updateControls(from) {
  if (!report) return;
  const rows = report.comparisons.filter(r => r.method === $("method-select").value && r.context_tokens === CONTEXT_TOKENS);
  const batches = distinct(rows.map(r => r.batch_size));
  selectOptions("batch-select", batches, v => `${v} ${v === 1 ? "sequence" : "sequences"}`);
  if (from === "initial") {
    // Prefer the largest actual equal-batch comparison where both methods succeeded.
    const comparable = rows.filter(r => r.status === "ok" && report.comparisons.some(b =>
      b.method === "baseline" && b.status === "ok" && b.context_tokens === r.context_tokens && b.batch_size === r.batch_size));
    const initial = comparable.length ? Math.max(...comparable.map(r => r.batch_size)) : batches[0];
    if (initial !== undefined) $("batch-select").value = String(initial);
  }
  renderComparison();
}

function selectedRow(method) {
  return report.comparisons.find(r => r.method === method && r.context_tokens === CONTEXT_TOKENS &&
    r.batch_size === Number($("batch-select").value) && (method === "baseline" || r.target_ratio === TARGET_RATIO));
}

function smallerBaseline(batch) {
  return report.comparisons.filter(r => r.method === "baseline" && r.status === "ok" &&
    r.context_tokens === CONTEXT_TOKENS && r.batch_size < batch).sort((a, b) => b.batch_size - a.batch_size)[0];
}

function recordedAnswer(row, example) {
  return row?.status === "ok" ? row.runs.filter(r => r.repeat === 0).flatMap(r => r.answers).find(a => a.example_id === example.id) : null;
}

function answerCard(prefix, row, example) {
  const checks = $(`${prefix}-checks`); checks.replaceChildren();
  if (!row || row.status !== "ok") {
    text(`${prefix}-answer`, row?.status === "oom" ? "This configuration ran out of GPU memory." : "No completed measurement for this setting.");
    text(`${prefix}-score`, row?.status === "oom" ? "Out of memory" : "Not measured"); return;
  }
  const answer = recordedAnswer(row, example);
  if (!answer) { text(`${prefix}-answer`, "Answer not recorded."); text(`${prefix}-score`, "—"); return; }
  text(`${prefix}-answer`, answer.answer || "(Empty answer)");
  text(`${prefix}-score`, pct(answer.score));
  (answer.correct || []).forEach((hit, i) => checks.append(elem("span", `${hit ? "✓" : "×"} ${example.fact_labels?.[i] || `Fact ${i + 1}`}`, hit ? "" : "missed")));
}

function renderComparison() {
  const example = report.examples.find(e => e.context_tokens === CONTEXT_TOKENS && typeof e.document === "string");
  if (!example) return;
  // Never substitute a different-batch baseline into the main comparison.
  const baseline = selectedRow("baseline"), compressed = selectedRow($("method-select").value);
  const batch = Number($("batch-select").value);
  text("run-batch", `batch ${batch}`);
  $("baseline-note").hidden = baseline?.status !== "oom";
  text("baseline-note", `The uncompressed baseline ran out of memory at batch ${batch}. The main comparison keeps the selected batch size on both sides; no smaller-batch answer or memory measurement is substituted.`);
  text("baseline-answer-label", `Uncompressed · batch ${batch}`);
  text("baseline-memory-label", `Baseline · batch ${batch}`);
  text("lowram-memory-label", `LowRAM · batch ${batch}`);
  text("baseline-column", `Baseline · batch ${batch}`);
  text("lowram-column", `LowRAM · batch ${batch}`);
  const b = baseline?.status === "ok" ? baseline.summary : null;
  const c = compressed?.status === "ok" ? compressed.summary : null;
  text("question", example.question);
  text("document-text", example.document);
  text("answer-method", `${names[$("method-select").value]} · batch ${batch}`);
  $("facts").replaceChildren(...example.references.map((ref, i) => elem("span", `${example.fact_labels?.[i] ? `${example.fact_labels[i]} · ` : ""}${ref}`, "fact-chip")));
  $("document-map").replaceChildren(...Array.from({length: 48}, () => elem("i")));
  (example.fact_positions || []).forEach((position, i) => {
    if (!Number.isFinite(position) || position < 0 || position > 1) return;
    const marker = elem("button", undefined, "fact-marker"); marker.type = "button";
    marker.style.left = `${position * 100}%`; marker.title = example.facts?.[i] || example.references[i];
    marker.setAttribute("aria-label", `${example.fact_labels?.[i] || `Fact ${i + 1}`} at ${Math.round(position * 100)}% of the prompt`);
    marker.onclick = () => { $("document-text").hidden = false; $("document-toggle").setAttribute("aria-expanded", "true"); text("document-toggle", "Hide document"); };
    $("document-map").append(marker);
  });
  answerCard("baseline", baseline, example); answerCard("lowram", compressed, example);
  const baseBytes = b?.physical_compressed_bytes?.mean, lowBytes = c?.physical_compressed_bytes?.mean;
  text("baseline-memory", baseline?.status === "oom" ? "Out of memory" : bytes(baseBytes));
  text("lowram-memory", compressed?.status === "oom" ? "Out of memory" : bytes(lowBytes));
  const scale = Math.max(baseBytes || 0, lowBytes || 0, 1);
  $("baseline-bar").style.width = `${(baseBytes || 0) / scale * 100}%`;
  $("lowram-bar").style.width = `${(lowBytes || 0) / scale * 100}%`;
  $("baseline-bar").parentElement.classList.toggle("unavailable", !b);
  $("lowram-bar").parentElement.classList.toggle("unavailable", !c);
  text("memory-saving", baseBytes && lowBytes ? (baseBytes >= lowBytes ? `${number(baseBytes / lowBytes, 2)}× smaller cache` : `${number(lowBytes / baseBytes, 2)}× larger cache`) : c?.physical_compression_ratio?.mean ? `${number(c.physical_compression_ratio.mean, 2)}× LowRAM cache ratio` : "Not measured");
  const metrics = [
    ["Decode throughput", s => `${number(s?.decode_tokens_per_s?.mean)} tok/s`],
    ["Time to first token", s => `${number(s?.ttft_s?.mean, 2)} s`],
    ["End-to-end throughput", s => `${number(s?.end_to_end_tokens_per_s?.mean)} tok/s`],
    ["Peak GPU tensor memory", s => bytes(s?.peak_allocated_bytes)],
    ["Peak GPU reserved memory", s => bytes(s?.peak_reserved_bytes)],
    ["Suite fact recall", s => pct(s?.accuracy?.score)],
  ];
  $("metric-rows").replaceChildren(...metrics.map(([label, format]) => {
    const tr = elem("tr"); tr.append(elem("td", label), elem("td", b ? format(b) : baseline?.status === "oom" ? "OOM" : "—"), elem("td", c ? format(c) : compressed?.status === "oom" ? "OOM" : "—")); return tr;
  }));
  const reference = baseline?.status === "oom" ? smallerBaseline(batch) : null;
  const referenceEl = $("baseline-reference");
  referenceEl.hidden = !reference;
  referenceEl.open = false;
  if (reference) {
    const answer = recordedAnswer(reference, example);
    text("reference-setting", `Separate reference only: uncompressed baseline at batch ${reference.batch_size}, not the selected batch ${batch}.`);
    text("reference-answer", answer ? `Recorded answer: ${answer.answer}` : "No answer was recorded for this example.");
    text("reference-memory", `Physical prefill KV cache: ${bytes(reference.summary.physical_compressed_bytes?.mean)}. This measurement is not used in the main memory bars or performance table.`);
  }
}

function svgEl(tag, attributes = {}, value) {
  const el = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.entries(attributes).forEach(([key, val]) => el.setAttribute(key, String(val)));
  if (value !== undefined) el.textContent = value;
  return el;
}

function chart(container, series, options) {
  const width = 960, height = 355, pad = {left: 65, right: 120, top: 27, bottom: 58};
  const x = value => pad.left + (value - options.xMin) / (options.xMax - options.xMin) * (width - pad.left - pad.right);
  const y = value => height - pad.bottom - (value - options.yMin) / (options.yMax - options.yMin) * (height - pad.top - pad.bottom);
  const svg = svgEl("svg", {viewBox: `0 0 ${width} ${height}`, role: "group", "aria-label": options.title});
  svg.append(svgEl("title", {}, options.title));
  options.yTicks.forEach(tick => {
    svg.append(svgEl("line", {x1: pad.left, x2: width - pad.right, y1: y(tick), y2: y(tick), class: tick === 100 && options.baseline ? "gridline reference" : "gridline"}));
    svg.append(svgEl("text", {x: pad.left - 12, y: y(tick) + 4, "text-anchor": "end", class: "tick"}, tick));
  });
  options.xTicks.forEach(tick => svg.append(svgEl("text", {x: x(tick), y: height - 33, "text-anchor": "middle", class: "tick"}, options.xFormat ? options.xFormat(tick) : tick)));
  svg.append(svgEl("text", {x: pad.left + (width - pad.left - pad.right) / 2, y: height - 7, "text-anchor": "middle", class: "axis-label"}, options.xLabel));
  svg.append(svgEl("text", {x: pad.left, y: 12, "text-anchor": "start", class: "axis-label"}, options.yLabel));
  const legend = elem("div", undefined, "chart-legend"), labels = [];
  series.forEach(({name, points}) => {
    const color = colors[name] || colors.LowRAM;
    const valid = points.filter(p => p.status !== "oom" && Number.isFinite(p.y)).sort((a, b) => a.x - b.x);
    svg.append(svgEl("polyline", {points: valid.map(p => `${x(p.x)},${y(p.y)}`).join(" "), fill: "none", stroke: color, "stroke-width": 2.5}));
    points.forEach(point => {
      const oom = point.status === "oom";
      if (!oom && !Number.isFinite(point.y)) return;
      const cx = x(point.x), cy = y(oom ? options.yMin : point.y);
      const circle = svgEl("circle", {cx, cy, r: oom ? 4 : 5, fill: oom ? "var(--bg)" : color, stroke: color, "stroke-width": 1.5, tabindex: 0, role: "button", "aria-label": point.detail, class: "point"});
      circle.append(svgEl("title", {}, point.detail));
      const show = () => text(options.detail, point.detail);
      circle.addEventListener("click", show); circle.addEventListener("mouseenter", show); circle.addEventListener("focus", show);
      circle.addEventListener("keydown", e => { if (["Enter", " "].includes(e.key)) { e.preventDefault(); show(); } });
      svg.append(circle);
      if (oom) svg.append(svgEl("text", {x: cx, y: cy - 11, "text-anchor": "middle", class: "oom-label"}, "OOM"));
    });
    const last = valid[valid.length - 1];
    if (last) labels.push({name, color, x: x(last.x) + 10, y: y(last.y) + 4});
    const label = elem("span"), dot = elem("i"); dot.style.background = color; label.append(dot, document.createTextNode(name)); legend.append(label);
  });
  labels.sort((a, b) => a.y - b.y).forEach((label, i, all) => { if (i && label.y - all[i - 1].y < 14) label.y = all[i - 1].y + 14; });
  labels.forEach(({name, color, x: lx, y: ly}) => {
    svg.append(svgEl("circle", {cx: lx + 3, cy: ly - 4, r: 3, fill: color}));
    svg.append(svgEl("text", {x: lx + 10, y: ly, class: "series-label"}, name));
  });
  $(container).replaceChildren(svg, legend);
}

function accuracyChart() {
  if (!paper) return;
  const series = Object.keys(paper.long_context).map(name => ({name, points: paper.long_context[name].map(([ratio, score]) => ({
    x: ratio, y: score, detail: `${name} · ${ratio}× compression · ${number(100 / ratio)}% of baseline cache memory · ${score}% recovered LongBench score. Mistral-7B, contexts >10K; paper Table 11.`
  }))}));
  chart("accuracy-chart", series, {title: "Recovered benchmark score versus KV-cache compression ratio", xMin: 0, xMax: 30, yMin: 25, yMax: 105, xTicks: [1, 5, 10, 15, 20, 25, 30], xFormat: tick => `${tick}×`, yTicks: [40, 60, 80, 100], xLabel: "KV-cache compression ratio →", yLabel: "Recovered benchmark score (%) ↑", baseline: true, detail: "accuracy-detail"});
}

function throughputChart() {
  if (!archive) return;
  const context = 262144;
  const series = archive.runs.map(run => ({name: run.label, points: run.results.filter(r => r.prompt_len === context).map(r => ({
    x: r.batch_size, y: r.decode_tokens_per_s, status: r.status, detail: `${run.label} · batch ${r.batch_size} · ${r.status === "oom" ? "out of memory" : `${number(r.decode_tokens_per_s)} aggregate tok/s`}`
  }))}));
  chart("throughput-chart", series, {title: "Archived decode throughput versus batch size", xMin: 0, xMax: 30, yMin: 0, yMax: 320, xTicks: [1, 4, 8, 12, 18, 24, 28], yTicks: [0, 100, 200, 300], xLabel: "Batch size →", yLabel: "Aggregate decode throughput (tokens / second) ↑", detail: "throughput-detail"});
}

const steps = [
  ["K ≈ A · B", "Shared structure, smaller keys.", "A shared factor captures patterns across a group of layers. Each layer keeps its own smaller reconstruction factor."],
  ["<span class=\"accented\">V<span class=\"accent\">ˆ</span></span> = ƒ<sub>θ</sub>(K)", "Learn the relationship once per context.", "A lightweight predictor adapts to the current prompt to reconstruct values from keys. Its parameter cost is amortised over a long document."],
  ["<span class=\"accented\">V<span class=\"accent\">˜</span></span> = ƒ<sub>θ</sub>(K) + ΔV", "Spend memory on the hard cases.", "Store sparse residual corrections for the worst-reconstructed values. The target compression ratio determines how many corrections fit."],
  ["Query → select → reconstruct", "Rebuild only what the query needs.", "Landmarks select relevant chunks. Reuse recently reconstructed chunks, while retaining outliers and a local window exactly."],
];
function methodStep(index) {
  if (!Number.isInteger(index) || index < 0 || index >= steps.length) return;
  document.querySelectorAll(".method-step").forEach((b, i) => { b.classList.toggle("active", i === index); b.setAttribute("aria-pressed", String(i === index)); });
  const matrix = (count, type = "") => { const m = elem("div", undefined, `matrix ${type}`); m.append(...Array.from({length: count}, () => elem("i"))); return m; };
  const op = value => elem("span", value, "operator");
  const predictor = elem("div", "ƒ", "predictor-symbol"); predictor.append(elem("sub", "θ"));
  const stages = [() => [matrix(36), op("≈"), matrix(12, "thin"), op("·"), matrix(12, "wide")],
    () => [matrix(36), op("→"), predictor, op("→"), matrix(36, "wide")],
    () => [predictor, op("+"), matrix(24, "exceptions"), op("→"), matrix(36, "wide")],
    () => [matrix(48, "selected"), op("→"), matrix(12), op("→"), predictor]];
  $("visual-stage").replaceChildren(...stages[index]());
  $("method-formula").innerHTML = steps[index][0]; text("method-title", steps[index][1]); text("method-caption", steps[index][2]);
}

// Copy controls work independently of benchmark-data loading.
async function copyText(value) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return true; } catch { /* Try the local-file fallback. */ }
  }
  const active = document.activeElement;
  const area = document.createElement("textarea");
  area.value = value; area.setAttribute("readonly", ""); area.style.cssText = "position:fixed;left:-9999px;top:0;opacity:0";
  document.body.append(area); area.select();
  let ok = false;
  try { ok = document.execCommand("copy"); } catch { ok = false; }
  area.remove();
  if (active instanceof HTMLElement) active.focus({preventScroll:true});
  return ok;
}

document.querySelectorAll("[data-copy-target]").forEach(button => {
  const normalLabel = button.textContent;
  button.addEventListener("click", async () => {
    const target = $(button.dataset.copyTarget);
    if (!target) return;
    const ok = await copyText(target.textContent);
    if (ok) {
      button.textContent = "Copied!";
      text("copy-status", `${normalLabel === "Copy BibTeX" ? "BibTeX" : "Code"} copied to the clipboard.`);
      setTimeout(() => { button.textContent = normalLabel; }, 2000);
    } else {
      const range = document.createRange(); range.selectNodeContents(target);
      const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
      button.textContent = "Text selected";
      text("copy-status", "Automatic copying is unavailable. The text is selected; press Ctrl+C or Command+C to copy.");
    }
  });
});

document.querySelector(".full-grid").append(...Array.from({length: 80}, () => elem("i")));
document.querySelector(".small-grid").append(...Array.from({length: 30}, () => elem("i")));
document.querySelectorAll(".method-step").forEach(b => b.addEventListener("click", () => methodStep(Number(b.dataset.step)))); methodStep(0);
["method", "batch"].forEach(key => $(`${key}-select`).addEventListener("change", () => updateControls(key)));
$("document-toggle").onclick = () => { const show = $("document-text").hidden; $("document-text").hidden = !show; $("document-toggle").setAttribute("aria-expanded", String(show)); text("document-toggle", show ? "Hide document" : "Read document"); };

async function fetchJSON(url, headers) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12000);
  try {
    const response = await fetch(url, {cache:"no-store", signal:controller.signal, ...(headers ? {headers} : {})});
    if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timer); }
}

async function getJSON(path) {
  // Normal deployed use reads ./data first. The pinned public fallback enables a
  // double-click local preview without a build step. No credentials are needed.
  const embedded = window.LOWRAM_EMBEDDED_DATA?.[path];
  if (location.protocol === "file:" && embedded) return embedded;
  if (location.protocol !== "file:") {
    try { return await fetchJSON(path); } catch { /* Try the bundled or pinned public copy. */ }
    if (embedded) return embedded;
  }
  try {
    return await fetchJSON(`https://raw.githubusercontent.com/${DATA_REPO}/${DATA_REF}/${path}`);
  } catch {
    return await fetchJSON(`https://api.github.com/repos/${DATA_REPO}/contents/${path}?ref=${DATA_REF}`, {Accept:"application/vnd.github.raw+json"});
  }
}

window.LOWRAM_LOADS = Promise.allSettled([
  getJSON("data/comparison.json").then(acceptReport).catch(error => {
    text("run-label", "Recorded data unavailable");
    text("run-hardware", "GPU metadata loads with the recorded data.");
    $("load-error").hidden = false;
    text("load-error", location.protocol === "file:"
      ? "The full recorded demo needs an internet connection in this review bundle. To make it work offline, run prepare_offline.py once from the bundle, then reopen this page. No measurements have been substituted."
      : "The recorded results could not be loaded. Check the data folder or the connection to the public repository. The remaining page and citation controls still work.");
    console.warn("LowRAM recorded demo:", error.message);
  }),
  getJSON("data/paper.json").then(data => { paper = data; accuracyChart(); }).catch(error => {
    text("accuracy-detail", "Paper data could not be loaded. Read the linked paper for the results.");
    console.warn("LowRAM paper data:", error.message);
  }),
  getJSON("data/throughput.json").then(data => { archive = data; throughputChart(); }).catch(error => {
    text("throughput-detail", "The recorded throughput data could not be loaded. Connect to the internet, or run prepare_offline.py once for a fully offline review.");
    console.warn("LowRAM throughput data:", error.message);
  }),
]);
