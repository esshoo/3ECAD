import type { ViewerLayer, ViewportState } from "../layers/ViewerLayer";

export class PdfLayer implements ViewerLayer {
  readonly id = "pdf-layer";
  visible = true;

  private canvas: HTMLCanvasElement | null = null;
  private context: CanvasRenderingContext2D | null = null;
  private viewport: ViewportState | null = null;

  attach(container: HTMLElement): void {
    if (this.canvas) {
      return;
    }

    const canvas = document.createElement("canvas");
    canvas.style.position = "absolute";
    canvas.style.left = "0";
    canvas.style.top = "0";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    canvas.style.pointerEvents = "none";
    canvas.dataset.layer = "pdf";

    container.appendChild(canvas);

    this.canvas = canvas;
    this.context = canvas.getContext("2d");
  }

  detach(): void {
    if (this.canvas?.parentElement) {
      this.canvas.parentElement.removeChild(this.canvas);
    }

    this.canvas = null;
    this.context = null;
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    if (!this.canvas) {
      return;
    }

    this.canvas.width = Math.max(1, Math.floor(width * devicePixelRatio));
    this.canvas.height = Math.max(1, Math.floor(height * devicePixelRatio));
  }

  setViewport(viewport: ViewportState): void {
    this.viewport = viewport;
  }

  render(): void {
    if (!this.canvas || !this.context || !this.viewport) {
      return;
    }

    const ctx = this.context;
    const dpr = this.viewport.devicePixelRatio;

    ctx.save();
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, this.viewport.width, this.viewport.height);

    ctx.fillStyle = "rgba(255, 255, 255, 0.08)";
    ctx.fillRect(24, 24, 260, 90);

    ctx.fillStyle = "#ffffff";
    ctx.font = "14px Arial";
    ctx.fillText("3ECAD PDF Layer Ready", 44, 58);
    ctx.fillText(`scale: ${this.viewport.scale.toFixed(2)}`, 44, 84);

    ctx.restore();
  }
}
