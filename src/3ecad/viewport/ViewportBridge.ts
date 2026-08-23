import type { ViewportState } from "../layers/ViewerLayer";

export function createDefaultViewport(width: number, height: number): ViewportState {
  return {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
    rotation: 0,
    width,
    height,
    devicePixelRatio: window.devicePixelRatio || 1,
  };
}
