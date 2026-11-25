import qrcode from "qrcode-generator";

// Returns an SVG QR code for `text` (dark modules on a transparent background, scales to its box).
window.dashboardQr = text => {
    const qr = qrcode(0, "M");
    qr.addData(text);
    qr.make();
    return qr.createSvgTag({ cellSize: 4, margin: 0, scalable: true });
};
