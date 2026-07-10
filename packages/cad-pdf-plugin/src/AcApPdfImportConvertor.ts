import type { AcApContext } from '@mlightcad/cad-simple-viewer'
import {
  AcDbLine,
  AcDbPolyline,
  AcDbRasterImage,
  AcGePoint2d,
  AcGePoint3d,
  log
} from '@mlightcad/data-model'
import * as pdfjsLib from 'pdfjs-dist'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.mjs?url'
import type {
  PDFOperatorList,
  PDFPageProxy
} from 'pdfjs-dist/types/src/display/api'

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl

/** 1 PDF point in mm (1 pt = 1/72 inch = 25.4/72 mm) */
const PT_TO_MM = 25.4 / 72

/** Bezier approximation resolution (line segments per curve) */
const BEZIER_STEPS = 8

const PDF_BACKGROUND_LAYER = 'PDF_PAGE_1_BACKGROUND'

/** 2D point in PDF user space before conversion to model-space mm. */
type Point2 = { x: number; y: number }

type PdfImportEntity = AcDbPolyline | AcDbLine | AcDbRasterImage

type ViewLike = {
  addEntity?: (entity: PdfImportEntity) => void
  zoomToFitDrawing?: () => void
}

/**
 * Converts a PDF file into CAD entities appended to the current document's
 * model space.
 */
export class AcApPdfImportConvertor {
  /**
   * Prompts the user to pick a PDF file and imports vector geometry.
   *
   * @param context - Application context for the target document
   */
  importFromFilePicker(context: AcApContext) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = '.pdf'
    input.style.display = 'none'
    document.body.appendChild(input)

    input.addEventListener('change', async () => {
      const file = input.files?.[0]
      document.body.removeChild(input)
      if (!file) return
      const buffer = await file.arrayBuffer()
      await this.convert(context, buffer)
    })

    input.click()
  }

  /**
   * Converts the first page of a PDF ArrayBuffer into CAD entities.
   * If no vector paths are found, it imports the PDF page as a raster image.
   *
   * @param context - Application context for the target document
   * @param data - Raw PDF bytes
   * @param pageNumber - 1-based page number (default: 1)
   */
  async convert(context: AcApContext, data: ArrayBuffer, pageNumber = 1) {
    try {
      const pdf = await pdfjsLib.getDocument({ data }).promise
      const page = await pdf.getPage(pageNumber)
      const viewport = page.getViewport({ scale: 1 })
      const pageHeight = viewport.height

      const operatorList = await page.getOperatorList()

      const opNameByCode = new Map<number, string>(
        Object.entries(pdfjsLib.OPS).map(([name, code]) => [
          Number(code),
          name
        ])
      )

      const opCounts = new Map<string, number>()

      for (const fn of operatorList.fnArray) {
        const name = opNameByCode.get(Number(fn)) ?? `UNKNOWN_${fn}`
        opCounts.set(name, (opCounts.get(name) ?? 0) + 1)
      }

      const opSummary = Array.from(opCounts.entries())
        .sort((a, b) => b[1] - a[1])
        .map(([name, count]) => `${name}:${count}`)
        .join(', ')

      log.info(`[PdfImport DEBUG] PDF operator counts: ${opSummary}`)

      const firstConstructIndex = operatorList.fnArray.findIndex(
        fn => Number(fn) === Number(pdfjsLib.OPS.constructPath)
      )

      if (firstConstructIndex >= 0) {
        const firstArgs = operatorList.argsArray[firstConstructIndex] as any

        log.info(
          `[PdfImport DEBUG] first constructPath raw arg types: ${
            Array.isArray(firstArgs)
              ? firstArgs.map((x: any) =>
                  x == null
                    ? 'null'
                    : `${Object.prototype.toString.call(x)} len=${x.length ?? 'na'}`
                ).join(' | ')
              : Object.prototype.toString.call(firstArgs)
          }`
        )

        log.info(
          `[PdfImport DEBUG] first constructPath arg0 sample: ${
            Array.isArray(firstArgs)
              ? JSON.stringify(Array.from(firstArgs[0] ?? []).slice(0, 30))
              : 'not-array'
          }`
        )

        log.info(
          `[PdfImport DEBUG] first constructPath arg1 sample: ${
            Array.isArray(firstArgs)
              ? JSON.stringify(Array.from(firstArgs[1] ?? []).slice(0, 60))
              : 'not-array'
          }`
        )

        log.info(
          `[PdfImport DEBUG] first constructPath arg2 sample: ${
            Array.isArray(firstArgs)
              ? JSON.stringify(firstArgs[2] ?? null)
              : 'not-array'
          }`
        )
      }

      const entities = this.extractEntities(operatorList, pageHeight)

      if (entities.length === 0) {
        log.warn(
          '[PdfImport] No vector paths found. Importing page as raster image instead.'
        )
        await this.importRasterPage(context, page, pageNumber)
        return
      }

      const modelSpace = context.doc.database.tables.blockTable.modelSpace
      const view = this.getView(context)

      for (const entity of entities) {
        modelSpace.appendEntity(entity)
        view?.addEntity?.(entity)
      }

      view?.zoomToFitDrawing?.()

      log.info(`[PdfImport] Imported ${entities.length} vector entities from PDF.`)
    } catch (err) {
      log.error('[PdfImport] Failed to import PDF:', err)
    }
  }

  private async importRasterPage(
    context: AcApContext,
    page: PDFPageProxy,
    pageNumber: number
  ) {
    const scale = 2
    const viewport = page.getViewport({ scale })

    const canvas = document.createElement('canvas')
    const canvasContext = canvas.getContext('2d')

    if (!canvasContext) {
      throw new Error('Canvas 2D context is not available.')
    }

    canvas.width = Math.ceil(viewport.width)
    canvas.height = Math.ceil(viewport.height)

    await page.render({
      canvasContext,
      viewport
    } as any).promise

    const blob = await this.canvasToPngBlob(canvas)

    const pageWidthMm = viewport.width * PT_TO_MM
    const pageHeightMm = viewport.height * PT_TO_MM

    const docWithLayerService = context.doc as AcApContext['doc'] & {
      layerService?: {
        createLayers?: (names: string[]) => void
      }
    }

    docWithLayerService.layerService?.createLayers?.([PDF_BACKGROUND_LAYER])

    const image = new AcDbRasterImage()

    image.layer = PDF_BACKGROUND_LAYER
    image.image = blob
    image.position = new AcGePoint3d(0, 0, 0)
    image.width = pageWidthMm
    image.height = pageHeightMm
    image.imageSize = new AcGePoint2d(canvas.width, canvas.height)
    image.isImageShown = true
    image.isImageTransparent = false
    image.isClipped = false
    image.rotation = 0

    const modelSpace = context.doc.database.tables.blockTable.modelSpace
    modelSpace.appendEntity(image)

    const view = this.getView(context)
    view?.addEntity?.(image)
    view?.zoomToFitDrawing?.()

    log.info(
      `[PdfImport] Imported PDF page ${pageNumber} as raster image ${canvas.width}x${canvas.height}.`
    )
  }

  private canvasToPngBlob(canvas: HTMLCanvasElement): Promise<Blob> {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (!blob) {
          reject(new Error('Failed to convert PDF canvas to PNG blob.'))
          return
        }

        resolve(blob)
      }, 'image/png')
    })
  }

  private getView(context: AcApContext): ViewLike | undefined {
    return (context as AcApContext & { view?: ViewLike }).view
  }

  private extractEntities(
    opList: PDFOperatorList,
    pageHeight: number
  ): (AcDbPolyline | AcDbLine)[] {
    const { OPS } = pdfjsLib
    const { fnArray, argsArray } = opList
    const result: (AcDbPolyline | AcDbLine)[] = []

    // PDF.js constructPath uses DrawOPS numbers, not OPS.moveTo/lineTo directly.
    const DRAW_MOVE_TO = 0
    const DRAW_LINE_TO = 1
    const DRAW_CURVE_TO = 2
    const DRAW_QUADRATIC_CURVE_TO = 3
    const DRAW_CLOSE_PATH = 4

    let subpaths: Point2[][] = []
    let current: Point2[] = []
    let curX = 0
    let curY = 0

    const tx = (x: number, _y: number) => x * PT_TO_MM
    const ty = (_x: number, y: number) => (pageHeight - y) * PT_TO_MM

    const flush = () => {
      if (current.length > 1) subpaths.push(current)
      current = []
    }

    const commit = () => {
      flush()
      for (const sp of subpaths) {
        const entity = this.subpathToEntity(sp)
        if (entity) result.push(entity)
      }
      subpaths = []
    }

    const moveTo = (x: number, y: number) => {
      flush()
      curX = x
      curY = y
      current = [{ x: tx(x, y), y: ty(x, y) }]
    }

    const lineTo = (x: number, y: number) => {
      curX = x
      curY = y
      current.push({ x: tx(x, y), y: ty(x, y) })
    }

    const curveTo = (
      x1: number,
      y1: number,
      x2: number,
      y2: number,
      x3: number,
      y3: number
    ) => {
      const pts = cubicBezier(
        { x: curX, y: curY },
        { x: x1, y: y1 },
        { x: x2, y: y2 },
        { x: x3, y: y3 },
        BEZIER_STEPS
      )

      for (const p of pts) {
        current.push({ x: tx(p.x, p.y), y: ty(p.x, p.y) })
      }

      curX = x3
      curY = y3
    }

    const quadraticCurveTo = (
      x1: number,
      y1: number,
      x2: number,
      y2: number
    ) => {
      for (let step = 1; step <= BEZIER_STEPS; step++) {
        const t = step / BEZIER_STEPS
        const mt = 1 - t
        const x = mt * mt * curX + 2 * mt * t * x1 + t * t * x2
        const y = mt * mt * curY + 2 * mt * t * y1 + t * t * y2
        current.push({ x: tx(x, y), y: ty(x, y) })
      }

      curX = x2
      curY = y2
    }

    const closePath = () => {
      if (current.length > 0) {
        current.push({ ...current[0] })
      }
      flush()
    }

    const rectangle = (x: number, y: number, width: number, height: number) => {
      moveTo(x, y)
      lineTo(x + width, y)
      lineTo(x + width, y + height)
      lineTo(x, y + height)
      closePath()
    }

    const processConstructPath = (
      pathOps: ArrayLike<number>,
      pathArgs: ArrayLike<number>
    ) => {
      let argIndex = 0

      const take = () => Number(pathArgs[argIndex++])

      for (let i = 0; i < pathOps.length; i++) {
        const pathOp = Number(pathOps[i])

        switch (pathOp) {
          case DRAW_MOVE_TO:
          case OPS.moveTo: {
            moveTo(take(), take())
            break
          }
          case DRAW_LINE_TO:
          case OPS.lineTo: {
            lineTo(take(), take())
            break
          }
          case DRAW_CURVE_TO:
          case OPS.curveTo: {
            curveTo(take(), take(), take(), take(), take(), take())
            break
          }
          case OPS.curveTo2: {
            curveTo(curX, curY, take(), take(), take(), take())
            break
          }
          case OPS.curveTo3: {
            const x1 = take()
            const y1 = take()
            const x3 = take()
            const y3 = take()
            curveTo(x1, y1, x3, y3, x3, y3)
            break
          }
          case DRAW_QUADRATIC_CURVE_TO: {
            quadraticCurveTo(take(), take(), take(), take())
            break
          }
          case OPS.rectangle: {
            rectangle(take(), take(), take(), take())
            break
          }
          case DRAW_CLOSE_PATH:
          case OPS.closePath: {
            closePath()
            break
          }
        }
      }
    }

    const processPackedPathStream = (
      packedStream: ArrayLike<number>,
      minMax?: ArrayLike<number>
    ) => {
      let index = 0

      let maxAbs = 0
      if (minMax) {
        for (let i = 0; i < minMax.length; i++) {
          maxAbs = Math.max(maxAbs, Math.abs(Number(minMax[i])))
        }
      }

      // In this PDF.js output, packed path coordinates are fixed-point x100.
      // Example from debug: 27118 means 271.18 PDF points.
      const packedScale = maxAbs > pageHeight * 10 ? 0.01 : 1
      const take = () => Number(packedStream[index++]) * packedScale

      while (index < packedStream.length) {
        const pathOp = Number(packedStream[index++])

        switch (pathOp) {
          case DRAW_MOVE_TO: {
            moveTo(take(), take())
            break
          }
          case DRAW_LINE_TO: {
            lineTo(take(), take())
            break
          }
          case DRAW_CURVE_TO: {
            curveTo(take(), take(), take(), take(), take(), take())
            break
          }
          case DRAW_QUADRATIC_CURVE_TO: {
            quadraticCurveTo(take(), take(), take(), take())
            break
          }
          case DRAW_CLOSE_PATH: {
            closePath()
            break
          }
          case OPS.rectangle: {
            rectangle(take(), take(), take(), take())
            break
          }
          default: {
            // Unknown packed op. Stop this stream to avoid reading wrong coordinates.
            return
          }
        }
      }
    }
    for (let i = 0; i < fnArray.length; i++) {
      const fn = fnArray[i]
      const rawArgs = argsArray[i] as unknown

      switch (fn) {
        case OPS.constructPath: {
          const constructArgs = rawArgs as any[]

          const maybePathOps = constructArgs[0]
          const maybePathArgs = constructArgs[1]
          const maybeMinMax = constructArgs[2] as ArrayLike<number> | undefined

          if (
            maybePathOps &&
            maybePathArgs &&
            (Array.isArray(maybePathOps) || ArrayBuffer.isView(maybePathOps))
          ) {
            processConstructPath(
              maybePathOps as ArrayLike<number>,
              maybePathArgs as ArrayLike<number>
            )
          } else if (Array.isArray(maybePathArgs)) {
            for (const packedStream of maybePathArgs) {
              if (
                packedStream &&
                (Array.isArray(packedStream) || ArrayBuffer.isView(packedStream))
              ) {
                processPackedPathStream(
                  packedStream as ArrayLike<number>,
                  maybeMinMax
                )
              }
            }
          } else if (
            maybePathArgs &&
            (Array.isArray(maybePathArgs) || ArrayBuffer.isView(maybePathArgs))
          ) {
            processPackedPathStream(
              maybePathArgs as ArrayLike<number>,
              maybeMinMax
            )
          }

          break
        }
        case OPS.moveTo: {
          const args = rawArgs as number[]
          moveTo(args[0], args[1])
          break
        }
        case OPS.lineTo: {
          const args = rawArgs as number[]
          lineTo(args[0], args[1])
          break
        }
        case OPS.curveTo: {
          const args = rawArgs as number[]
          curveTo(args[0], args[1], args[2], args[3], args[4], args[5])
          break
        }
        case OPS.curveTo2: {
          const args = rawArgs as number[]
          curveTo(curX, curY, args[0], args[1], args[2], args[3])
          break
        }
        case OPS.curveTo3: {
          const args = rawArgs as number[]
          curveTo(args[0], args[1], args[2], args[3], args[2], args[3])
          break
        }
        case OPS.rectangle: {
          const args = rawArgs as number[]
          rectangle(args[0], args[1], args[2], args[3])
          break
        }
        case OPS.closePath: {
          closePath()
          break
        }
        case OPS.stroke:
        case OPS.fill:
        case OPS.eoFill:
        case OPS.fillStroke:
        case OPS.eoFillStroke:
        case OPS.closeStroke:
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke:
        case OPS.endPath: {
          commit()
          break
        }
      }
    }

    commit()
    return result
  }
  private subpathToEntity(pts: Point2[]): AcDbPolyline | AcDbLine | null {
    if (pts.length < 2) return null

    if (pts.length === 2) {
      return new AcDbLine(
        new AcGePoint3d(pts[0].x, pts[0].y, 0),
        new AcGePoint3d(pts[1].x, pts[1].y, 0)
      )
    }

    const poly = new AcDbPolyline()
    for (let i = 0; i < pts.length; i++) {
      poly.addVertexAt(i, new AcGePoint2d(pts[i].x, pts[i].y))
    }

    const first = pts[0]
    const last = pts[pts.length - 1]
    const dx = first.x - last.x
    const dy = first.y - last.y
    if (Math.sqrt(dx * dx + dy * dy) < 1e-6) {
      poly.closed = true
    }

    return poly
  }
}

/**
 * Approximates a cubic Bezier curve as a polyline.
 */
function cubicBezier(
  p0: Point2,
  p1: Point2,
  p2: Point2,
  p3: Point2,
  steps: number
): Point2[] {
  const pts: Point2[] = []
  for (let i = 1; i <= steps; i++) {
    const t = i / steps
    const mt = 1 - t
    const x =
      mt * mt * mt * p0.x +
      3 * mt * mt * t * p1.x +
      3 * mt * t * t * p2.x +
      t * t * t * p3.x
    const y =
      mt * mt * mt * p0.y +
      3 * mt * mt * t * p1.y +
      3 * mt * t * t * p2.y +
      t * t * t * p3.y
    pts.push({ x, y })
  }
  return pts
}





