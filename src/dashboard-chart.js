import * as echarts from "echarts/core";
import { BarChart, CandlestickChart, LineChart, ScatterChart } from "echarts/charts";
import {
    DataZoomComponent, GraphicComponent, GridComponent, MarkLineComponent, ToolboxComponent, TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import "./icons.js";
import "./qr.js";

echarts.use([
    BarChart, CandlestickChart, LineChart, ScatterChart, DataZoomComponent, GraphicComponent, GridComponent, MarkLineComponent,
    ToolboxComponent, TooltipComponent, CanvasRenderer,
]);

const overlays = { sma: true, trades: true, levels: true };
// Price panel style: "line" (the bot's own prices) or "candles" (1-minute OHLC candles from the market collector).
// Remembered per browser; storage can be blocked, so guard it.
let priceMode = (() => { try { return localStorage.getItem("ae-chart-mode") === "candles" ? "candles" : "line"; } catch (e) { return "line"; } })();
const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000; // open on the last 2 hours
// Three stacked panels sharing one time axis: price, volume, order-book pressure.
const PANELS = { price: { top: 34, height: "50%" }, volume: { top: "66%", height: "10%" }, pressure: { top: "81%", height: "8%" } };
const AXES = [0, 1, 2];
let chart;
let chartData = { points: [], trades: [], fastN: 0, slowN: 0, trips: [], candles: [], book: [] };
const BUY_SIDES = new Set(["BUY", "COVER"]); // SELL and SHORT are sells
let userZoomed = false; // once the user zooms or pans, stop following the latest data
let applyingZoom = false;

function themeColor(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function formatPrice(value) {
    const digits = Math.abs(value) >= 1000 ? 0 : 2;
    return "$" + Number(value).toLocaleString(undefined, {
        minimumFractionDigits: digits,
        maximumFractionDigits: digits,
    });
}

function findLevels(points) {
    const valid = points.filter(point => Number.isFinite(point.price));
    if (valid.length < 7) return [];

    const pivots = [];
    for (let index = 2; index < valid.length - 2; index++) {
        const neighbors = [...valid.slice(index - 2, index), ...valid.slice(index + 1, index + 3)];
        const price = valid[index].price;
        const isHigh = neighbors.every(point => point.price <= price) && neighbors.some(point => point.price < price);
        const isLow = neighbors.every(point => point.price >= price) && neighbors.some(point => point.price > price);
        if (isHigh !== isLow) pivots.push({ price, kind: isHigh ? "Resistance" : "Support" });
    }

    if (!pivots.length) return [];
    const latest = valid[valid.length - 1].price;
    const prices = valid.map(point => point.price);
    const tolerance = Math.max(latest * 0.0015, (Math.max(...prices) - Math.min(...prices)) * 0.025);
    const clusters = [];

    for (const pivot of pivots.sort((a, b) => a.price - b.price)) {
        let cluster = clusters[clusters.length - 1];
        if (!cluster || pivot.price - cluster.max > tolerance) {
            cluster = { prices: [], max: pivot.price };
            clusters.push(cluster);
        }
        cluster.prices.push(pivot.price);
        cluster.max = pivot.price;
    }

    const levels = clusters.map(cluster => ({
        price: cluster.prices.reduce((sum, value) => sum + value, 0) / cluster.prices.length,
        touches: cluster.prices.length,
    }));
    const select = kind => {
        const candidates = levels.filter(level => kind === "Support" ? level.price < latest : level.price > latest);
        const repeated = candidates.filter(level => level.touches > 1);
        const pool = repeated.length ? repeated : candidates;
        return pool.sort((a, b) => Math.abs(a.price - latest) - Math.abs(b.price - latest))[0];
    };

    return ["Support", "Resistance"].map(kind => {
        const level = select(kind);
        return level && { ...level, kind };
    }).filter(Boolean);
}

// Points arrive about once per bot interval. When the bot was offline (no internet, phone asleep),
// insert a null so the line breaks instead of drawing a straight line across the missing hours.
function gapThresholdMs(points) {
    const steps = [];
    for (let index = 1; index < points.length; index++) {
        steps.push((Number(points[index].ts) - Number(points[index - 1].ts)) * 1000);
    }
    if (!steps.length) return Infinity;
    steps.sort((a, b) => a - b);
    const typical = steps[Math.floor(steps.length / 2)];
    return Math.max(typical * 3, 180000);
}

function seriesWithGaps(points, key, gapMs) {
    const data = [];
    let previous = null;
    for (const point of points) {
        const time = Number(point.ts) * 1000;
        if (previous !== null && time - previous > gapMs) data.push([previous + 1, null]);
        data.push([time, point[key]]);
        previous = time;
    }
    return data;
}

// One line per completed buy→sell (green = profit, red = loss); the open trade runs to "now", dashed.
function tripLines(trips, end) {
    return trips.map(trip => {
        const color = themeColor(trip.pnl >= 0 ? "--good" : "--bad");
        const exitTime = trip.exit_ts ? Number(trip.exit_ts) * 1000 : end;
        return [{
            coord: [Number(trip.entry_ts) * 1000, trip.entry_price],
            lineStyle: { color, width: 2.5, type: trip.open ? "dashed" : "solid", opacity: .9 },
            // Labels would tilt along the line and get hard to read; the table has the exact numbers.
            label: { show: false },
        }, {
            coord: [exitTime, trip.exit_price],
        }];
    });
}

function tradeMarkers(trades, side) {
    const buy = side === "BUY";
    const color = themeColor(buy ? "--good" : "--bad");
    return {
        name: buy ? "Buy" : "Sell",
        type: "scatter",
        z: 10,
        // A short is a sell and a cover is a buy, so they share the S / B pins.
        data: trades.filter(trade => (BUY_SIDES.has(trade.side) ? "BUY" : "SELL") === side).map(trade => [Number(trade.ts) * 1000, trade.price]),
        // A pin whose tip sits exactly on the trade price.
        symbol: "pin",
        symbolSize: 30,
        symbolOffset: [0, "-50%"],
        itemStyle: { color, borderColor: themeColor("--bg"), borderWidth: 1.5 },
        label: {
            show: true,
            position: "inside",
            offset: [0, -3],
            formatter: buy ? "B" : "S",
            color: themeColor("--bg"),
            fontSize: 11,
            fontWeight: "bold",
        },
        emphasis: { scale: 1.2 },
    };
}

function buildOption() {
    const { points, trades, fastN, slowN, trips } = chartData;
    const accent = themeColor("--accent");
    const sub = themeColor("--sub");
    const border = themeColor("--border");
    const levels = overlays.levels ? findLevels(points) : [];
    const levelSummary = document.getElementById("chart-levels");
    levelSummary.replaceChildren(...levels.map(level => {
        const label = document.createElement("span");
        label.className = `chart-level ${level.kind.toLowerCase()}`;
        label.textContent = `${level.kind} ${formatPrice(level.price)}`;
        return label;
    }));
    const start = points.length ? Number(points[0].ts) * 1000 : 0;
    const end = points.length ? Number(points[points.length - 1].ts) * 1000 : 0;
    const gapMs = gapThresholdMs(points);
    const good = themeColor("--good");
    const bad = themeColor("--bad");
    const useCandles = priceMode === "candles" && chartData.candles.length > 0;
    const priceSeries = useCandles ? {
        name: "Candles",
        type: "candlestick",
        barMaxWidth: 8,
        // ECharts candle order on a time axis: [time, open, close, low, high]
        data: chartData.candles.map(c => [Number(c.ts) * 1000, c.open, c.close, c.low, c.high]),
        itemStyle: { color: good, color0: bad, borderColor: good, borderColor0: bad },
    } : {
        name: "Price",
        type: "line",
        data: seriesWithGaps(points, "price", gapMs),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: accent, width: 2 },
        areaStyle: { color: "rgba(198, 239, 99, .055)" },
    };
    const series = [{
        ...priceSeries,
        markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            data: [...levels.map(level => {
                const color = level.kind === "Support" ? themeColor("--good") : themeColor("--warn");
                return {
                    name: level.kind,
                    yAxis: level.price,
                    lineStyle: { color, type: "dashed", width: 1 },
                    label: {
                        color: themeColor("--bg"),
                        backgroundColor: color,
                        fontSize: 9,
                        fontWeight: "bold",
                        padding: [2, 4],
                        borderRadius: 3,
                        formatter: level.kind === "Support" ? "S" : "R",
                        position: "insideEndTop",
                    },
                };
            }), ...(overlays.trades ? tripLines(trips.filter(trip => Number(trip.entry_ts) * 1000 >= start), end) : [])],
        },
    }];

    // fastN / slowN are the line names the bot reports (e.g. "SMA 5", "Trend (30-min avg)");
    // a bot without a fast line passes null and that line is skipped.
    if (overlays.sma) {
        if (fastN) series.push({
            name: fastN,
            type: "line",
            data: seriesWithGaps(points, "fast", gapMs),
            showSymbol: false,
            connectNulls: false,
            lineStyle: { color: themeColor("--fast"), width: 1.3 },
        });
        if (slowN) series.push({
            name: slowN,
            type: "line",
            data: seriesWithGaps(points, "slow", gapMs),
            showSymbol: false,
            connectNulls: false,
            lineStyle: { color: themeColor("--slow"), width: 1.3 },
        });
    }

    if (overlays.trades) {
        const visibleTrades = trades.filter(trade => Number(trade.ts) * 1000 >= start && Number(trade.ts) * 1000 <= end + 60000);
        series.push(tradeMarkers(visibleTrades, "BUY"), tradeMarkers(visibleTrades, "SELL"));
    }

    // Volume per minute, green when the candle closed up, red when it closed down.
    series.push({
        name: "Volume",
        type: "bar",
        xAxisIndex: 1,
        yAxisIndex: 1,
        barMaxWidth: 6,
        barMinWidth: 1,
        data: chartData.candles.map(candle => ({
            value: [Number(candle.ts) * 1000, candle.volume],
            itemStyle: { color: candle.close >= candle.open ? good : bad, opacity: .75 },
        })),
    });

    // Order-book pressure: share of resting size on the bid side minus the ask side.
    series.push({
        name: "Pressure",
        type: "bar",
        xAxisIndex: 2,
        yAxisIndex: 2,
        barMaxWidth: 6,
        barMinWidth: 1,
        data: chartData.book.map(row => ({
            value: [Number(row.ts) * 1000, row.imbalance],
            itemStyle: { color: row.imbalance >= 0 ? good : bad, opacity: .75 },
        })),
    });

    // All three panels must share one time range, otherwise each axis fits its own data and
    // the zoom window lands on different times in each panel.
    const times = [
        ...points.map(p => Number(p.ts) * 1000),
        ...chartData.candles.map(c => Number(c.ts) * 1000),
        ...chartData.book.map(b => Number(b.ts) * 1000),
    ];
    const xMin = times.length ? Math.min(...times) : undefined;
    const xMax = times.length ? Math.max(...times) : undefined;

    const axisText = { color: sub, fontSize: 10 };
    const panelLabel = (text, top) => ({
        type: "text", left: 10, top, silent: true, style: { text, fill: sub, fontSize: 10, fontWeight: "bold" },
    });

    return {
        animation: false,
        grid: Object.values(PANELS).map(panel => ({ left: 12, right: 74, ...panel })),
        axisPointer: { link: [{ xAxisIndex: "all" }] },
        toolbox: {
            right: 74,
            top: 0,
            itemSize: 16,
            itemGap: 12,
            iconStyle: { borderColor: sub },
            emphasis: { iconStyle: { borderColor: accent } },
            feature: {
                dataZoom: {
                    xAxisIndex: AXES,
                    yAxisIndex: false,
                    title: { zoom: "Drag a box to zoom", back: "Undo last zoom" },
                },
            },
        },
        tooltip: {
            trigger: "axis",
            axisPointer: { type: "cross", lineStyle: { color: sub, opacity: .65 } },
            backgroundColor: themeColor("--card"),
            borderColor: border,
            textStyle: { color: themeColor("--text"), fontSize: 12 },
            formatter(params) {
                const items = Array.isArray(params) ? params : [params];
                const timestamp = Number(items[0]?.axisValue);
                const heading = Number.isFinite(timestamp) ? new Date(timestamp).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "Price";
                const show = (name, value) => {
                    if (name === "Volume") return value.toFixed(3) + " BTC";
                    if (name === "Pressure") return (value >= 0 ? "+" : "−") + Math.abs(value * 100).toFixed(0) + "% " + (value >= 0 ? "buyers" : "sellers");
                    return formatPrice(value);
                };
                const rows = items.filter(item => item.value && item.value[1] != null).map(item => {
                    if (item.seriesType === "candlestick") {
                        const [, open, close, low, high] = item.data;
                        const color = close >= open ? good : bad;
                        return `<div>${item.marker}O ${formatPrice(open)} · H ${formatPrice(high)} · L ${formatPrice(low)} · <b style="color:${color}">C ${formatPrice(close)}</b></div>`;
                    }
                    return `<div>${item.marker}${item.seriesName}: <b>${show(item.seriesName, item.value[1])}</b></div>`;
                });
                return `<strong>${heading}</strong>${rows.join("")}`;
            },
        },
        // One time axis per panel, kept in sync by the shared dataZoom; only the bottom one shows labels.
        xAxis: AXES.map(index => ({
            type: "time",
            gridIndex: index,
            min: xMin,
            max: xMax,
            boundaryGap: false,
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            axisLabel: { ...axisText, hideOverlap: true, show: index === 2 },
            axisPointer: { label: { show: index === 2 } },
            splitLine: { show: false },
        })),
        yAxis: [{
            type: "value",
            gridIndex: 0,
            position: "right",
            scale: true,
            axisLabel: { ...axisText, formatter: value => formatPrice(value) },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: border, type: "dashed" } },
        }, {
            type: "value",
            gridIndex: 1,
            position: "right",
            min: 0,
            splitNumber: 2,
            axisLabel: { ...axisText, formatter: value => value.toFixed(1) },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: border, type: "dashed" } },
        }, {
            type: "value",
            gridIndex: 2,
            position: "right",
            min: -1,
            max: 1,
            interval: 1,
            axisLabel: { ...axisText, formatter: value => value === 0 ? "0" : (value > 0 ? "buy" : "sell") },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: border, type: "dashed" } },
        }],
        dataZoom: [{
            id: "zoom-inside",
            type: "inside",
            xAxisIndex: AXES,
            zoomOnMouseWheel: "shift",
            moveOnMouseMove: true,
            zoomOnTouchPinch: true,
        }, {
            id: "zoom-slider",
            type: "slider",
            xAxisIndex: AXES,
            height: 22,
            bottom: 8,
            borderColor: border,
            fillerColor: "rgba(198, 239, 99, .12)",
            handleStyle: { color: themeColor("--card"), borderColor: sub },
            moveHandleStyle: { color: border },
            dataBackground: { lineStyle: { color: sub, opacity: .5 }, areaStyle: { opacity: 0 } },
            textStyle: { color: sub, fontSize: 10 },
            labelFormatter: value => new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
        }],
        graphic: [
            panelLabel("VOLUME · BTC per minute", "61.5%"),
            panelLabel("ORDER-BOOK PRESSURE · near the price", "77%"),
            ...(points.length < 2 ? [{
                type: "text",
                left: "center",
                top: "25%",
                style: { text: "Collecting prices…", fill: sub, fontSize: 13 },
            }] : []),
        ],
        series,
    };
}

function render() {
    if (!chart) return;
    chart.setOption(buildOption(), { replaceMerge: ["series", "graphic"] });
    followLatest();
}

function setRange(range) {
    if (!chart) return;
    if (range === "all") {
        userZoomed = true;
        applyingZoom = true;
        chart.dispatchAction({ type: "dataZoom", start: 0, end: 100 });
        applyingZoom = false;
    } else {
        userZoomed = false;
        followLatest();
    }
}

// Until the user zooms or pans, keep the view on the most recent DEFAULT_WINDOW_MS.
function followLatest() {
    const { points } = chartData;
    if (userZoomed || points.length < 2) return;
    const first = Number(points[0].ts) * 1000;
    const last = Number(points[points.length - 1].ts) * 1000;
    applyingZoom = true;
    chart.dispatchAction({ type: "dataZoom", startValue: Math.max(first, last - DEFAULT_WINDOW_MS), endValue: last });
    applyingZoom = false;
}

function init() {
    const element = document.getElementById("chart");
    if (!element || chart) return;

    chart = echarts.init(element, null, { renderer: "canvas" });
    document.querySelector("[data-mode]")?.setAttribute("aria-pressed", String(priceMode === "candles"));
    chart.on("datazoom", () => {
        if (!applyingZoom) userZoomed = true;
    });
    document.getElementById("chart-controls").addEventListener("click", event => {
        const rangeButton = event.target.closest("[data-range]");
        if (rangeButton) return setRange(rangeButton.dataset.range);
        const modeButton = event.target.closest("[data-mode]");
        if (modeButton) {
            priceMode = priceMode === "candles" ? "line" : "candles";
            try { localStorage.setItem("ae-chart-mode", priceMode); } catch (e) { /* not essential */ }
            modeButton.setAttribute("aria-pressed", String(priceMode === "candles"));
            return render();
        }
        const button = event.target.closest("[data-overlay]");
        if (!button) return;
        const key = button.dataset.overlay;
        overlays[key] = !overlays[key];
        button.setAttribute("aria-pressed", String(overlays[key]));
        render();
    });

    if ("ResizeObserver" in window) {
        new ResizeObserver(() => chart.resize()).observe(element);
    } else {
        window.addEventListener("resize", () => chart.resize());
    }
    render();
}

function update(points, trades, fastN, slowN, trips) {
    chartData = { ...chartData, points: points || [], trades: trades || [], fastN, slowN, trips: trips || [] };
    render();
}

function updateMarket(candles, book) {
    chartData = { ...chartData, candles: candles || [], book: book || [] };
    render();
}

// ---------- small "money since start" chart ----------
let equityChart;

function updateEquity(points, start, hideCash) {
    const element = document.getElementById("equity-chart");
    if (!element) return;
    if (!equityChart) {
        equityChart = echarts.init(element, null, { renderer: "canvas" });
        if ("ResizeObserver" in window) new ResizeObserver(() => equityChart.resize()).observe(element);
        else window.addEventListener("resize", () => equityChart.resize());
    }
    const sub = themeColor("--sub");
    const border = themeColor("--border");
    const idle = themeColor("--sub");  // "disabled" colour for time spent in cash (drawn faded)
    const money = value => "$" + Number(value).toLocaleString(undefined, { maximumFractionDigits: 0 });
    const pctOf = value => ((value / start - 1) * 100 >= 0 ? "+" : "−") + Math.abs((value / start - 1) * 100).toFixed(2) + "%";
    const when = ts => new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

    // points: [ts, after fees, before fees, invested]. A point belongs to an invested stretch if the bot was
    // holding at that point or just before it (so the closing trade's point is included).
    const rows = points.map((p, i) => ({
        t: Number(p[0]) * 1000, w: p[1], nf: p[2],
        on: p[3] === 1 || (i > 0 && points[i - 1][3] === 1) ? 1 : 0,
    }));
    const shown = hideCash ? rows.filter(r => r.on) : rows;
    // Hidden cash time: plain sequence axis (stretches joined end to end), labelled with the real times.
    const x = (r, i) => hideCash ? i : r.t;

    equityChart.setOption({
        animation: false,
        grid: { left: 8, right: 64, top: 10, bottom: 22 },
        tooltip: {
            trigger: "axis",
            backgroundColor: themeColor("--card"),
            borderColor: border,
            textStyle: { color: themeColor("--text"), fontSize: 12 },
            formatter(params) {
                const items = Array.isArray(params) ? params : [params];
                const row = shown[items[0]?.dataIndex];
                if (!row) return "";
                const seen = new Set();
                const lines = items.filter(item => item.value[1] != null && !seen.has(item.seriesName) && seen.add(item.seriesName));
                return `<strong>${when(row.t)}</strong>${row.on ? "" : " <span style=\"opacity:.7\">· in cash</span>"}` + lines.map(item =>
                    `<div>${item.marker}${item.seriesName}: <b>${money(item.value[1])}</b> (${pctOf(item.value[1])})</div>`).join("");
            },
        },
        xAxis: hideCash ? {
            type: "value",
            min: 0,
            max: Math.max(1, shown.length - 1),
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            axisLabel: { color: sub, fontSize: 10, hideOverlap: true, formatter: i => shown[Math.round(i)] ? new Date(shown[Math.round(i)].t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "" },
            splitLine: { show: false },
        } : {
            type: "time",
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            axisLabel: { color: sub, fontSize: 10, hideOverlap: true },
            splitLine: { show: false },
        },
        yAxis: {
            type: "value",
            position: "right",
            scale: true,
            splitNumber: 3,
            axisLabel: { color: sub, fontSize: 10, formatter: money },
            splitLine: { lineStyle: { color: border, type: "dashed" } },
        },
        // Each line is drawn twice: invested parts in colour, in-cash parts in grey. Gaps are null; the
        // parts share the point at each buy / sell so the line stays continuous.
        series: (() => {
            const n = shown.length;
            const invested = i => shown[i].on || (i + 1 < n && shown[i + 1].on);
            const cash = i => !shown[i].on || (i + 1 < n && !shown[i + 1].on);
            const part = (key, keep) => shown.map((r, i) => [x(r, i), keep(i) ? r[key] : null]);
            const line = (name, key, keep, color, style) => ({
                name,
                type: "line",
                step: "end",
                showSymbol: false,
                connectNulls: false,
                data: part(key, keep),
                lineStyle: { color, ...style },
                itemStyle: { color },
            });
            const accent = themeColor("--accent");
            const slow = themeColor("--slow");
            return [
                {
                    ...line("After fees", "w", invested, accent, { width: 2 }),
                    markLine: {
                        silent: true,
                        symbol: "none",
                        data: [{ yAxis: start }],
                        lineStyle: { color: sub, type: "dotted", width: 1 },
                        label: { color: sub, fontSize: 9, formatter: "start", position: "insideStartTop" },
                    },
                },
                line("Before fees", "nf", invested, slow, { width: 1.5, type: "dashed" }),
                line("After fees", "w", cash, idle, { width: 2, opacity: .45 }),
                line("Before fees", "nf", cash, idle, { width: 1.5, type: "dashed", opacity: .45 }),
            ];
        })(),
        graphic: shown.length ? [] : [{
            type: "text", left: "center", top: "middle",
            style: { text: hideCash ? "Not invested yet" : "No data yet", fill: sub, fontSize: 12 },
        }],
    }, { notMerge: true });
}

// Server detail dialogs (CPU, memory, storage, temperature, battery): one time chart with up to two
// y-axes. spec = { series: [{ name, color (CSS var), data: [[ms, value]], axis (0 left / 1 right), area, dashed }],
//                  axes: [{ min, max, format }], marks: [{ y, label, color }], empty }
let metricChart;
function updateMetric(spec) {
    const element = document.getElementById("md-chart");
    if (!element) return;
    if (!metricChart) {
        metricChart = echarts.init(element, null, { renderer: "canvas" });
        if ("ResizeObserver" in window) new ResizeObserver(() => metricChart.resize()).observe(element);
        else window.addEventListener("resize", () => metricChart.resize());
    }
    const sub = themeColor("--sub");
    const border = themeColor("--border");
    const axes = spec.axes.length ? spec.axes : [{}];
    const fmtAxis = (axis) => (v) => axis.format ? axis.format(v) : String(v);
    const ts = spec.series.flatMap(s => s.data.length ? [s.data[0][0], s.data[s.data.length - 1][0]] : []);
    const span = ts.length ? Math.max(...ts) - Math.min(...ts) : 0;
    const when = (ms) => new Date(ms).toLocaleString([], span > 20 * 3600e3 ?
        { weekday: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } :
        { hour: "2-digit", minute: "2-digit", second: span < 1800e3 ? "2-digit" : undefined });
    metricChart.setOption({
        animation: false,
        grid: { left: 8, right: 8, top: 16, bottom: 4, containLabel: true },
        tooltip: {
            trigger: "axis",
            backgroundColor: themeColor("--card"),
            borderColor: border,
            textStyle: { color: themeColor("--text"), fontSize: 12 },
            formatter(params) {
                const items = Array.isArray(params) ? params : [params];
                if (!items.length) return "";
                return `<strong>${when(items[0].value[0])}</strong>` + items.filter(i => i.value[1] != null).map(i => {
                    const axis = axes[spec.series[i.seriesIndex].axis || 0] || {};
                    return `<div>${i.marker}${i.seriesName}: <b>${fmtAxis(axis)(i.value[1])}</b></div>`;
                }).join("");
            },
        },
        xAxis: {
            type: "time",
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            axisLabel: { color: sub, fontSize: 10, hideOverlap: true },
            splitLine: { show: false },
        },
        yAxis: axes.map((axis, i) => ({
            type: "value",
            position: i ? "right" : "left",
            min: axis.min,
            max: axis.max,
            scale: axis.min == null,
            splitNumber: 4,
            axisLabel: { color: sub, fontSize: 10, formatter: fmtAxis(axis) },
            splitLine: { show: i === 0, lineStyle: { color: border, type: "dashed" } },
        })),
        series: spec.series.map((s, i) => {
            const color = themeColor(s.color);
            return {
                name: s.name,
                type: "line",
                yAxisIndex: s.axis || 0,
                showSymbol: false,
                connectNulls: false,
                smooth: 0.2,
                data: s.data,
                lineStyle: { color, width: s.dashed ? 1.5 : 2, type: s.dashed ? "dashed" : "solid" },
                itemStyle: { color },
                areaStyle: s.area ? {
                    color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                        { offset: 0, color: color + "55" }, { offset: 1, color: color + "05" }]),
                } : undefined,
                markLine: i === 0 && spec.marks && spec.marks.length ? {
                    silent: true,
                    symbol: "none",
                    data: spec.marks.map(m => ({
                        yAxis: m.y,
                        lineStyle: { color: themeColor(m.color || "--sub"), type: "dotted", width: 1 },
                        label: { color: themeColor(m.color || "--sub"), fontSize: 9, formatter: m.label, position: "insideEndTop" },
                    })),
                } : undefined,
            };
        }),
        graphic: spec.series.some(s => s.data.some(p => p[1] != null)) ? [] : [{
            type: "text", left: "center", top: "middle",
            style: { text: spec.empty || "No data yet", fill: sub, fontSize: 12 },
        }],
    }, { notMerge: true });
}

// Per-core view of the CPU dialog: one small chart per core, % of the time that core was busy.
// cores = [{ data: [[ms, % or null]] }]; the cards around the charts are made by the page (#md-cores > .md-core).
const coreCharts = [];
function updateCores(cores) {
    const holders = document.querySelectorAll("#md-cores .md-core-chart");
    const accent = themeColor("--accent");
    const border = themeColor("--border");
    holders.forEach((element, i) => {
        let chart = coreCharts[i];
        if (!chart || chart.getDom() !== element) {
            if (chart) chart.dispose();
            chart = coreCharts[i] = echarts.init(element, null, { renderer: "canvas" });
            if ("ResizeObserver" in window) new ResizeObserver(() => chart.resize()).observe(element);
        }
        const data = (cores[i] && cores[i].data) || [];
        chart.setOption({
            animation: false,
            grid: { left: 0, right: 0, top: 2, bottom: 0 },
            tooltip: {
                trigger: "axis",
                backgroundColor: themeColor("--card"),
                borderColor: border,
                textStyle: { color: themeColor("--text"), fontSize: 11 },
                formatter: (p) => p[0] ? `${new Date(p[0].value[0]).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}: <b>${p[0].value[1] == null ? "off" : Math.round(p[0].value[1]) + "%"}</b>` : "",
            },
            xAxis: { type: "time", show: false },
            yAxis: { type: "value", min: 0, max: 100, show: true, axisLabel: { show: false }, splitNumber: 2,
                splitLine: { lineStyle: { color: border, type: "dashed" } } },
            series: [{
                type: "line", showSymbol: false, connectNulls: false, data,
                lineStyle: { color: accent, width: 1.5 }, itemStyle: { color: accent },
                areaStyle: { color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
                    { offset: 0, color: accent + "50" }, { offset: 1, color: accent + "05" }]) },
            }],
        }, { notMerge: true });
    });
    coreCharts.splice(holders.length).forEach((c) => c.dispose());
}

window.dashboardChart = { init, update, updateMarket, updateEquity, updateMetric, updateCores };
