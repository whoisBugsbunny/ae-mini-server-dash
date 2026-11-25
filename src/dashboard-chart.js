import * as echarts from "echarts/core";
import { BarChart, LineChart, ScatterChart } from "echarts/charts";
import {
    DataZoomComponent, GraphicComponent, GridComponent, MarkLineComponent, ToolboxComponent, TooltipComponent,
} from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Activity, CircleDot, Crosshair, createIcons } from "lucide";
import "./qr.js";

echarts.use([
    BarChart, LineChart, ScatterChart, DataZoomComponent, GraphicComponent, GridComponent, MarkLineComponent,
    ToolboxComponent, TooltipComponent, CanvasRenderer,
]);

const overlays = { sma: true, trades: true, levels: true };
const DEFAULT_WINDOW_MS = 2 * 60 * 60 * 1000; // open on the last 2 hours
// Three stacked panels sharing one time axis: price, volume, order-book pressure.
const PANELS = { price: { top: 34, height: "50%" }, volume: { top: "66%", height: "10%" }, pressure: { top: "81%", height: "8%" } };
const AXES = [0, 1, 2];
let chart;
let chartData = { points: [], trades: [], fastN: 0, slowN: 0, trips: [], candles: [], book: [] };
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
        const sellTime = trip.sell_ts ? Number(trip.sell_ts) * 1000 : end;
        return [{
            coord: [Number(trip.buy_ts) * 1000, trip.buy_price],
            lineStyle: { color, width: 2.5, type: trip.open ? "dashed" : "solid", opacity: .9 },
            // Labels would tilt along the line and get hard to read; the table has the exact numbers.
            label: { show: false },
        }, {
            coord: [sellTime, trip.sell_price],
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
        data: trades.filter(trade => trade.side === side).map(trade => [Number(trade.ts) * 1000, trade.price]),
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
    const series = [{
        name: "Price",
        type: "line",
        data: seriesWithGaps(points, "price", gapMs),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: accent, width: 2 },
        areaStyle: { color: "rgba(198, 239, 99, .055)" },
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
            }), ...(overlays.trades ? tripLines(trips.filter(trip => Number(trip.buy_ts) * 1000 >= start), end) : [])],
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
    const good = themeColor("--good");
    const bad = themeColor("--bad");
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
    chart.on("datazoom", () => {
        if (!applyingZoom) userZoomed = true;
    });
    createIcons({ icons: { Activity, CircleDot, Crosshair } });
    document.getElementById("chart-controls").addEventListener("click", event => {
        const rangeButton = event.target.closest("[data-range]");
        if (rangeButton) return setRange(rangeButton.dataset.range);
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

window.dashboardChart = { init, update, updateMarket };