import type { ViewerLayer, ViewportState } from "./ViewerLayer";

export class LayerHost {
  private readonly layers: ViewerLayer[] = [];
  private container: HTMLElement | null = null;
  private viewport: ViewportState | null = null;

  attach(container: HTMLElement): void {
    this.container = container;

    for (const layer of this.layers) {
      layer.attach(container);
    }
  }

  addLayer(layer: ViewerLayer): void {
    this.layers.push(layer);

    if (this.container) {
      layer.attach(this.container);
    }

    if (this.viewport) {
      layer.setViewport(this.viewport);
      layer.render();
    }
  }

  removeLayer(layerId: string): void {
    const index = this.layers.findIndex((layer) => layer.id === layerId);

    if (index === -1) {
      return;
    }

    const [layer] = this.layers.splice(index, 1);
    layer.detach();
  }

  resize(width: number, height: number, devicePixelRatio: number): void {
    for (const layer of this.layers) {
      layer.resize(width, height, devicePixelRatio);
    }
  }

  setViewport(viewport: ViewportState): void {
    this.viewport = viewport;

    for (const layer of this.layers) {
      layer.setViewport(viewport);
    }
  }

  render(): void {
    for (const layer of this.layers) {
      if (layer.visible) {
        layer.render();
      }
    }
  }
}
