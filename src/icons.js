// Lucide icons used by the dashboard. Only the icons imported here end up in the bundle.
import {
    Activity, ArrowDownUp, ArrowLeftRight, Battery, BatteryCharging, BatteryLow, BatteryWarning, BookOpen, Bot, Box,
    Camera, ChartCandlestick, ChartColumn, ChartLine, CircleDot, Clock, Coins, Cpu, Crosshair, Globe, HardDrive, HeartPulse,
    KeyRound, Layers, MemoryStick, QrCode, Server, ServerCog, ShieldAlert, ShieldCheck, Smartphone, SquareTerminal, Thermometer, TrendingDown, TrendingUp,
    TriangleAlert, Wallet, Waves, Wifi, WifiOff, X, createElement, createIcons,
} from "lucide";

const ICONS = {
    Activity, ArrowDownUp, ArrowLeftRight, Battery, BatteryCharging, BatteryLow, BatteryWarning, BookOpen, Bot, Box,
    Camera, ChartCandlestick, ChartColumn, ChartLine, CircleDot, Clock, Coins, Cpu, Crosshair, Globe, HardDrive, HeartPulse,
    KeyRound, Layers, MemoryStick, QrCode, Server, ServerCog, ShieldAlert, ShieldCheck, Smartphone, SquareTerminal, Thermometer, TrendingDown, TrendingUp,
    TriangleAlert, Wallet, Waves, Wifi, WifiOff, X,
};

// kebab-case name ("chart-line") -> icon node, the same names <i data-lucide="..."> uses.
const BY_NAME = Object.fromEntries(
    Object.entries(ICONS).map(([pascal, node]) => [pascal.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase(), node]),
);

// Build one icon as an <svg> element, for cards the dashboard creates at runtime.
window.dashboardIcon = (name, className = "icon") => {
    const svg = createElement(BY_NAME[name] || Box);
    svg.setAttribute("class", className);
    svg.setAttribute("aria-hidden", "true");
    return svg;
};

// Replace the static <i data-lucide="..."> placeholders in the page.
createIcons({ icons: ICONS });
