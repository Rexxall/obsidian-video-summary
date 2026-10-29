import qrcode from 'qrcode-generator';

/** Draw a QR code as dark squares on a white canvas; scanners need the contrast in any theme. */
export function drawQrCode(container: HTMLElement, text: string, size = 180): HTMLCanvasElement {
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const modules = qr.getModuleCount();
  const quiet = 4;
  const cell = Math.max(2, Math.floor(size / (modules + quiet * 2)));
  const side = cell * (modules + quiet * 2);
  const canvas = container.createEl('canvas', {
    cls: 'setup-qr-canvas',
    attr: { width: String(side), height: String(side), 'aria-label': '登录二维码' },
  });
  const context = canvas.getContext('2d');
  if (!context) return canvas;
  context.fillStyle = '#ffffff';
  context.fillRect(0, 0, side, side);
  context.fillStyle = '#000000';
  for (let row = 0; row < modules; row += 1) {
    for (let col = 0; col < modules; col += 1) {
      if (qr.isDark(row, col)) {
        context.fillRect((col + quiet) * cell, (row + quiet) * cell, cell, cell);
      }
    }
  }
  return canvas;
}
