export interface ViewportState {
  scale: number;
  offsetX: number;
  offsetY: number;
  rotation?: number;
  width: number;
  height: number;
  devicePixelRatio: number;
}

export interface ViewerLayer {
  id: string;
  visible: boolean;

  attach(container: HTMLElement): void;
  detach(): void;

  resize(width: number, height: number, devicePixelRatio: number): void;
  setViewport(viewport: ViewportState): void;
  render(): void;
}
