const API_BASE = "";

// On static hosts (GitHub Pages etc.) the /api/* endpoints don't exist and the
// dashboard reads JSON snapshots exported to ./data/ instead. Detected once on
// the first fetch, then reused so the 30s refresh skips dead API calls.
let STATIC_MODE = false;

const NO_CACHE = { cache: "no-store" };

const fmt = new Intl.NumberFormat("en-US");
const fmtTokens = (n) => fmt.format(n);
const fmtCost = (n) => (n === null || n === undefined ? "—" : "$" + n.toFixed(4));

function todayStr(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

async function loadRows() {
  if (!STATIC_MODE) {
    const res = await fetch(`${API_BASE}/api/usage`);
    if (res.ok) {
      const data = await res.json();
      return data.rows || [];
    }
    STATIC_MODE = true;
  }
  const res = await fetch("data/usage.json", NO_CACHE);
  if (!res.ok) throw new Error(`data/usage.json failed: ${res.status}`);
  const data = await res.json();
  return data.rows || [];
}

async function loadAllTimeStats() {
  if (!STATIC_MODE) {
    const res = await fetch(`${API_BASE}/api/summary`);
    if (res.ok) {
      const data = await res.json();
      return data.models || [];
    }
    STATIC_MODE = true;
  }
  const res = await fetch("data/summary.json", NO_CACHE);
  if (!res.ok) throw new Error(`data/summary.json failed: ${res.status}`);
  const data = await res.json();
  return data.models || [];
}

let ALL_ROWS = [];

const BUCKET_COLORS = ["#ff7ad9", "#d3f36b", "#7de2ff", "#ffb86b", "#c79bff", "#8fffc1"];

function bucketKey(dateStr, bucket) {
  const d = new Date(dateStr + "T00:00:00");
  if (bucket === "daily") return dateStr;
  if (bucket === "weekly") {
    const diff = (d.getDay() + 6) % 7;
    d.setDate(d.getDate() - diff);
    return d.toISOString().slice(0, 10);
  }
  return dateStr.slice(0, 7);
}

function rowsInRange(range) {
  const cutoff = { daily: 0, weekly: -6, monthly: -29 }[range] ?? -3650;
  const from = todayStr(cutoff);
  return ALL_ROWS.filter((r) => r.date >= from);
}

function chartSeries(range) {
  const rows = ALL_ROWS;
  const buckets = new Map();
  const window = { daily: 30, weekly: 12, monthly: 12 }[range];

  const keys = [];
  if (range === "daily") {
    for (let i = window - 1; i >= 0; i--) keys.push(todayStr(-i));
  } else if (range === "weekly") {
    const anchor = bucketKey(todayStr(), "weekly");
    for (let i = window - 1; i >= 0; i--) {
      const d = new Date(anchor + "T00:00:00");
      d.setDate(d.getDate() - i * 7);
      keys.push(d.toISOString().slice(0, 10));
    }
  } else {
    const now = new Date();
    for (let i = window - 1; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      keys.push(d.toISOString().slice(0, 7));
    }
  }
  keys.forEach((k) => buckets.set(k, 0));

  const perModel = new Map();
  for (const r of rows) {
    const key = bucketKey(r.date, range);
    if (!buckets.has(key)) continue;
    const total = r.inputTokens + r.outputTokens + r.cacheTokens;
    buckets.set(key, buckets.get(key) + total);
    if (!perModel.has(r.model)) perModel.set(r.model, keys.map(() => 0));
    perModel.get(r.model)[keys.indexOf(key)] += total;
  }
  return {
    labels: keys,
    totals: keys.map((k) => buckets.get(k)),
    perModel: [...perModel.entries()],
  };
}

function aggregateByModel(rows) {
  const byModel = new Map();
  for (const r of rows) {
    if (!byModel.has(r.model)) {
      byModel.set(r.model, { model: r.model, input: 0, output: 0, cache: 0, requests: 0, cost: 0 });
    }
    const m = byModel.get(r.model);
    m.input += r.inputTokens;
    m.output += r.outputTokens;
    m.cache += r.cacheTokens || 0;
    m.requests += r.requests;
    m.cost += r.cost || 0;
  }
  return [...byModel.values()].sort((a, b) => b.input + b.output + b.cache - (a.input + a.output + a.cache));
}

let chart = null;

function renderChart(range) {
  const series = chartSeries(range);
  const ctx = document.getElementById("usage-chart").getContext("2d");
  const gradient = ctx.createLinearGradient(0, 0, 0, 340);
  gradient.addColorStop(0, "rgba(255, 122, 217, 0.55)");
  gradient.addColorStop(1, "rgba(255, 122, 217, 0.02)");

  const datasets = [
    {
      label: "Total tokens (all models)",
      data: series.totals,
      borderColor: "#ff7ad9",
      backgroundColor: gradient,
      fill: true,
      tension: 0.35,
      pointRadius: series.labels.length > 60 ? 0 : 3,
      pointHoverRadius: 5,
      borderWidth: 2,
      order: 0,
    },
    ...series.perModel.map(([model, values], i) => ({
      label: model,
      data: values,
      borderColor: BUCKET_COLORS[i % BUCKET_COLORS.length],
      backgroundColor: "transparent",
      borderDash: [4, 4],
      borderWidth: 1.5,
      pointRadius: 0,
      tension: 0.35,
      fill: false,
      order: 1,
      hidden: true,
    })),
  ];

  const config = {
    type: "line",
    data: { labels: series.labels, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          display: true,
          labels: { color: "rgba(255,255,255,0.8)", usePointStyle: true, boxWidth: 8 },
        },
        tooltip: {
          backgroundColor: "#2a1a5e",
          borderColor: "rgba(255,255,255,0.2)",
          borderWidth: 1,
          titleColor: "#fff",
          bodyColor: "#fff",
          callbacks: {
            label: (item) => ` ${item.dataset.label}: ${fmtTokens(item.parsed.y)} tokens`,
          },
        },
      },
      scales: {
        x: {
          grid: { color: "rgba(255,255,255,0.07)" },
          ticks: { color: "rgba(255,255,255,0.65)", maxTicksLimit: 12, maxRotation: 0 },
        },
        y: {
          grid: { color: "rgba(255,255,255,0.07)" },
          ticks: {
            color: "rgba(255,255,255,0.65)",
            callback: (v) => {
              if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(1) + "M";
              if (Math.abs(v) >= 1e3) return (v / 1e3).toFixed(0) + "K";
              return v;
            },
          },
        },
      },
    },
  };

  if (chart) chart.destroy();
  chart = new Chart(ctx, config);
}

function renderTable(range) {
  const byModel = aggregateByModel(rowsInRange(range));
  const tbody = document.querySelector("#usage-table tbody");
  const tfoot = document.querySelector("#usage-table tfoot");

  tbody.innerHTML = byModel
    .map((m) => {
      const total = m.input + m.output + m.cache;
      return `<tr>
        <td>${escapeHtml(m.model)}</td>
        <td>${fmtTokens(m.input)}</td>
        <td>${fmtTokens(m.output)}</td>
        <td>${fmtTokens(m.cache)}</td>
        <td>${fmtTokens(total)}</td>
        <td>${fmtTokens(m.requests)}</td>
        <td>${fmtCost(m.cost)}</td>
      </tr>`;
    })
    .join("");

  const totals = byModel.reduce(
    (acc, m) => ({
      input: acc.input + m.input,
      output: acc.output + m.output,
      cache: acc.cache + m.cache,
      requests: acc.requests + m.requests,
      cost: acc.cost + m.cost,
    }),
    { input: 0, output: 0, cache: 0, requests: 0, cost: 0 }
  );
  const totalTokens = totals.input + totals.output + totals.cache;
  tfoot.innerHTML = `<tr>
    <td>Total</td>
    <td>${fmtTokens(totals.input)}</td>
    <td>${fmtTokens(totals.output)}</td>
    <td>${fmtTokens(totals.cache)}</td>
    <td>${fmtTokens(totalTokens)}</td>
    <td>${fmtTokens(totals.requests)}</td>
    <td>${fmtCost(totals.cost)}</td>
  </tr>`;
}

function renderModelCards(range) {
  const byModel = aggregateByModel(rowsInRange(range));
  const grandTotal = byModel.reduce((s, m) => s + m.input + m.output + m.cache, 0) || 1;
  const container = document.getElementById("model-cards");

  container.innerHTML = byModel
    .map((m, i) => {
      const total = m.input + m.output + m.cache;
      const pct = ((total / grandTotal) * 100).toFixed(1);
      const avgReq = m.requests ? Math.round(total / m.requests) : 0;
      const cachePct = total ? ((m.cache / total) * 100).toFixed(1) : "0.0";
      return `<div class="card model-card">
        <h3><span class="model-dot" style="background:${BUCKET_COLORS[i % BUCKET_COLORS.length]}"></span>${escapeHtml(m.model)}</h3>
        <div class="model-row"><span>Total Tokens</span><span>${fmtTokens(total)}</span></div>
        <div class="model-row"><span>Share of Usage</span><span>${pct}%</span></div>
        <div class="model-row"><span>Cache Tokens</span><span>${fmtTokens(m.cache)} (${cachePct}%)</span></div>
        <div class="model-row"><span>Avg Tokens / Request</span><span>${fmtTokens(avgReq)}</span></div>
        <div class="model-row"><span>Requests</span><span>${fmtTokens(m.requests)}</span></div>
        <div class="model-row"><span>Cost</span><span>${fmtCost(m.cost)}</span></div>
      </div>`;
    })
    .join("");
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

async function renderAllTimeStats() {
  const models = await loadAllTimeStats();
  const totalTokens = models.reduce((s, m) => s + m.totalTokens, 0);
  const totalCost = models.reduce((s, m) => s + (m.cost || 0), 0);
  const totalRequests = models.reduce((s, m) => s + m.requests, 0);
  const lastUsed = models.reduce((s, m) => Math.max(s, m.lastUsed || 0), 0);
  document.getElementById("stat-total-tokens").textContent = fmtTokens(totalTokens);
  document.getElementById("stat-total-cost").textContent = "$" + totalCost.toFixed(4);
  document.getElementById("stat-total-requests").textContent = fmtTokens(totalRequests);
  document.getElementById("stat-model-count").textContent = String(models.length);
  document.getElementById("stat-last-activity").textContent = lastUsed
    ? new Date(lastUsed * 1000).toLocaleDateString()
    : "—";
}

function renderAll(range) {
  renderChart(range);
  renderTable(range);
  renderModelCards(range);
}

function setupToggle(toggleId, onChange) {
  const toggle = document.getElementById(toggleId);
  toggle.addEventListener("click", (e) => {
    const btn = e.target.closest(".range-btn");
    if (!btn) return;
    toggle.querySelectorAll(".range-btn").forEach((b) => b.classList.remove("active"));
    btn.classList.add("active");
    onChange(btn.dataset.range);
  });
}

async function init() {
  setupToggle("range-toggle", renderAll);
  setupToggle("table-range-toggle", renderAll);
  try {
    ALL_ROWS = await loadRows();
  } catch (err) {
    console.error(err);
    document.getElementById("stat-total-tokens").textContent = "API offline";
    return;
  }
  renderAllTimeStats().catch(console.error);
  renderAll("daily");
  setInterval(async () => {
    try {
      ALL_ROWS = await loadRows();
      const active = document.querySelector("#range-toggle .range-btn.active");
      renderAll(active ? active.dataset.range : "daily");
      renderAllTimeStats().catch(console.error);
    } catch (err) {
      console.error(err);
    }
  }, 30000);
}

init();
