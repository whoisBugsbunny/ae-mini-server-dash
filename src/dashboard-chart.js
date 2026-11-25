import * as echarts from "echarts/core";
import { LineChart, ScatterChart } from "echarts/charts";
import { DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent } from "echarts/components";
import { CanvasRenderer } from "echarts/renderers";
import { Activity, CircleDot, Crosshair, createIcons } from "lucide";

echarts.use([LineChart, ScatterChart, DataZoomComponent, GridComponent, MarkLineComponent, TooltipComponent, CanvasRenderer]);

const overlays = { sma: true, trades: true, levels: true };
let chart;
let chartData = { points: [], trades: [], fastN: 0, slowN: 0 };

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

function buildOption() {
    const { points, trades, fastN, slowN } = chartData;
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
    const series = [{
        name: "Price",
        type: "line",
        data: points.map(point => [Number(point.ts) * 1000, point.price]),
        showSymbol: false,
        connectNulls: false,
        lineStyle: { color: accent, width: 2 },
        areaStyle: { color: "rgba(198, 239, 99, .055)" },
        markLine: {
            silent: true,
            symbol: "none",
            animation: false,
            data: levels.map(level => {
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
            }),
        },
    }];

    if (overlays.sma) {
        series.push({
            name: `SMA ${fastN}`,
            type: "line",
            data: points.map(point => [Number(point.ts) * 1000, point.fast]),
            showSymbol: false,
            connectNulls: false,
            lineStyle: { color: themeColor("--fast"), width: 1.3 },
        }, {
            name: `SMA ${slowN}`,
            type: "line",
            data: points.map(point => [Number(point.ts) * 1000, point.slow]),
            showSymbol: false,
            connectNulls: false,
            lineStyle: { color: themeColor("--slow"), width: 1.3 },
        });
    }

    if (overlays.trades) {
        const visibleTrades = trades.filter(trade => Number(trade.ts) * 1000 >= start && Number(trade.ts) * 1000 <= end + 60000);
        for (const side of ["BUY", "SELL"]) {
            const buy = side === "BUY";
            series.push({
                name: buy ? "Buy" : "Sell",
                type: "scatter",
                data: visibleTrades.filter(trade => trade.side === side)
                    .map(trade => [Number(trade.ts) * 1000, trade.price]),
                symbol: "triangle",
                symbolRotate: buy ? 0 : 180,
                symbolSize: 10,
                itemStyle: { color: themeColor(buy ? "--good" : "--bad"), borderColor: themeColor("--card"), borderWidth: 1 },
                label: {
                    show: true,
                    position: "top",
                    formatter: buy ? "B" : "S",
                    color: themeColor(buy ? "--good" : "--bad"),
                    fontSize: 9,
                    fontWeight: "bold",
                },
            });
        }
    }

    return {
        animation: false,
        grid: { left: 8, right: 68, top: 16, bottom: 24, containLabel: true },
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
                const rows = items.filter(item => item.value && item.value[1] != null).map(item => {
                    return `<div>${item.marker}${item.seriesName}: <b>${formatPrice(item.value[1])}</b></div>`;
                });
                return `<strong>${heading}</strong>${rows.join("")}`;
            },
        },
        xAxis: {
            type: "time",
            boundaryGap: false,
            axisLine: { lineStyle: { color: border } },
            axisTick: { show: false },
            axisLabel: { color: sub, hideOverlap: true, fontSize: 10 },
            splitLine: { show: false },
        },
        yAxis: {
            type: "value",
            scale: true,
            axisLabel: { color: sub, fontSize: 10, formatter: value => formatPrice(value) },
            axisLine: { show: false },
            axisTick: { show: false },
            splitLine: { lineStyle: { color: border, type: "dashed" } },
        },
        dataZoom: [{
            type: "inside",
            zoomOnMouseWheel: "shift",
            moveOnMouseMove: true,
            zoomOnTouchPinch: true,
        }],
        graphic: points.length < 2 ? [{
            type: "text",
            left: "center",
            top: "middle",
            style: { text: "Collecting prices…", fill: sub, fontSize: 13 },
        }] : [],
        series,
    };
}

function render() {
    if (!chart) return;
    chart.setOption(buildOption(), { replaceMerge: ["series"] });
}

function init() {
    const element = document.getElementById("chart");
    if (!element || chart) return;

    chart = echarts.init(element, null, { renderer: "canvas" });
    createIcons({ icons: { Activity, CircleDot, Crosshair } });
    document.getElementById("chart-controls").addEventListener("click", event => {
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

function update(points, trades, fastN, slowN) {
    chartData = { points: points || [], trades: trades || [], fastN, slowN };
    render();
}

window.dashboardChart = { init, update };