import type { AcApContext } from '@mlightcad/cad-simple-viewer'
import {
  AcCmColor,
  AcCmColorMethod,
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

      // 3ECAD_PDF_OPERATOR_ANALYZER_START
      const compactPdfArg = (value: any, depth = 0): any => {
        if (value == null) return value

        const valueType = typeof value
        if (valueType !== 'object') return value

        if (ArrayBuffer.isView(value)) {
          const view = value as ArrayBufferView
          const arrayLike = value as unknown as {
            length?: number
            [index: number]: unknown
          }

          const length =
            typeof arrayLike.length === 'number'
              ? arrayLike.length
              : view.byteLength

          const sample =
            typeof arrayLike.length === 'number'
              ? Array.from(
                  { length: Math.min(arrayLike.length, 24) },
                  (_, index) => arrayLike[index]
                )
              : []

          return {
            type: Object.prototype.toString.call(value),
            length,
            byteLength: view.byteLength,
            sample
          }
        }

        if (Array.isArray(value)) {
          return {
            type: 'Array',
            length: value.length,
            sample: value.slice(0, 12).map(item => compactPdfArg(item, depth + 1))
          }
        }

        if (depth >= 2) {
          return {
            type: value?.constructor?.name ?? Object.prototype.toString.call(value)
          }
        }

        const output: Record<string, any> = {}
        for (const key of Object.keys(value).slice(0, 16)) {
          output[key] = compactPdfArg(value[key], depth + 1)
        }

        return output
      }

      const opName = (fn: unknown) =>
        opNameByCode.get(Number(fn)) ?? `UNKNOWN_${Number(fn)}`

      const interestingPdfOps = new Set([
        'save',
        'restore',
        'transform',
        'setLineWidth',
        'setDash',
        'setStrokeRGBColor',
        'setFillRGBColor',
        'setStrokeGray',
        'setFillGray',
        'setStrokeCMYKColor',
        'setFillCMYKColor',
        'constructPath',
        'stroke',
        'fill',
        'eoFill',
        'fillStroke',
        'eoFillStroke',
        'closeStroke',
        'closeFillStroke',
        'closeEOFillStroke',
        'clip',
        'eoClip',
        'endPath',
        'beginMarkedContent',
        'beginMarkedContentProps',
        'endMarkedContent',
        'paintImageXObject',
        'paintInlineImageXObject',
        'paintJpegXObject',
        'paintImageMaskXObject',
        'showText',
        'showSpacedText',
        'nextLineShowText',
        'setFont'
      ])

      const analyzeOperatorCounts: Record<string, number> = {}
      const analyzeSamples: Record<string, any[]> = {}
      const markedContentSamples: any[] = []
      const paintSequenceSamples: any[] = []

      let currentPathHasClip = false
      let pathOpCount = 0
      let pathSequenceIndex = 0

      for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex++) {
        const name = opName(operatorList.fnArray[opIndex])
        const args = operatorList.argsArray[opIndex]

        analyzeOperatorCounts[name] = (analyzeOperatorCounts[name] ?? 0) + 1

        if (interestingPdfOps.has(name)) {
          const bucket = (analyzeSamples[name] ??= [])
          if (bucket.length < 8) {
            bucket.push({
              index: opIndex,
              args: compactPdfArg(args)
            })
          }
        }

        if (name === 'beginMarkedContent' || name === 'beginMarkedContentProps') {
          if (markedContentSamples.length < 32) {
            markedContentSamples.push({
              index: opIndex,
              op: name,
              args: compactPdfArg(args)
            })
          }
        }

        if (name === 'constructPath') {
          pathOpCount++
        }

        if (name === 'clip' || name === 'eoClip') {
          currentPathHasClip = true
        }

        if (
          name === 'stroke' ||
          name === 'fill' ||
          name === 'eoFill' ||
          name === 'fillStroke' ||
          name === 'eoFillStroke' ||
          name === 'closeStroke' ||
          name === 'closeFillStroke' ||
          name === 'closeEOFillStroke' ||
          name === 'endPath'
        ) {
          if (paintSequenceSamples.length < 32) {
            paintSequenceSamples.push({
              sequence: pathSequenceIndex++,
              index: opIndex,
              paintOp: name,
              pathOpCount,
              hadClipBeforePaint: currentPathHasClip
            })
          }

          pathOpCount = 0
          currentPathHasClip = false
        }
      }

      let optionalContentReport: any = {
        available: false,
        groups: [],
        order: null,
        error: null
      }

      try {
        const optionalContentConfig = await (pdf as any).getOptionalContentConfig?.({
          intent: 'any'
        })

        const rawGroups = optionalContentConfig?.getGroups?.()

        const groups =
          rawGroups instanceof Map
            ? Array.from(rawGroups.entries()).map(([id, group]) => ({
                id,
                group: compactPdfArg(group)
              }))
            : rawGroups && typeof rawGroups === 'object'
              ? Object.entries(rawGroups).map(([id, group]) => ({
                  id,
                  group: compactPdfArg(group)
                }))
              : []

        optionalContentReport = {
          available: !!optionalContentConfig,
          groups,
          order:
            compactPdfArg((optionalContentConfig as any)?.order) ??
            compactPdfArg((optionalContentConfig as any)?._order) ??
            null,
          error: null
        }
      } catch (error) {
        optionalContentReport = {
          available: false,
          groups: [],
          order: null,
          error: error instanceof Error ? error.message : String(error)
        }
      }

      // 3ECAD_OPTIONAL_CONTENT_DEEP_DEBUG_START
      const collectOcgIdsFromOperatorList = () => {
        const ids = new Set<string>()

        for (let opIndex = 0; opIndex < operatorList.fnArray.length; opIndex++) {
          const name = opName(operatorList.fnArray[opIndex])

          if (name !== 'beginMarkedContentProps') continue

          const args = operatorList.argsArray[opIndex] as any[]
          const tag = args?.[0]
          const properties = args?.[1]

          if (tag === 'OC' && properties?.id) {
            ids.add(String(properties.id))
          }
        }

        return Array.from(ids).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
      }

      const markedOcgIds = collectOcgIdsFromOperatorList()

      const safeCall = (fn: (() => any) | undefined) => {
        try {
          return typeof fn === 'function' ? compactPdfArg(fn()) : 'missing'
        } catch (error) {
          return {
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }

      const readOptionalContentConfigDebug = async (intent: string) => {
        try {
          const config = await (pdf as any).getOptionalContentConfig?.({ intent })

          const protoKeys: string[] = []
          let proto = config ? Object.getPrototypeOf(config) : null

          while (proto && proto !== Object.prototype) {
            protoKeys.push(
              ...Object.getOwnPropertyNames(proto).filter(name => name !== 'constructor')
            )
            proto = Object.getPrototypeOf(proto)
          }

          const ownKeys = config
            ? Reflect.ownKeys(config).map(key => String(key))
            : []

          const groupLookups: Record<string, any> = {}

          for (const id of markedOcgIds) {
            const ocgRef = { type: 'OCG', id }

            groupLookups[id] = {
              getGroupById: safeCall(() => config?.getGroup?.(id)),
              getGroupByRef: safeCall(() => config?.getGroup?.(ocgRef)),
              isVisibleByRef: safeCall(() => config?.isVisible?.(ocgRef)),
              rawOwnValue: safeCall(() => (config as any)?.[id])
            }
          }

          return {
            intent,
            exists: !!config,
            constructorName: config?.constructor?.name ?? null,
            ownKeys,
            protoKeys: Array.from(new Set(protoKeys)),
            compactConfig: compactPdfArg(config),
            groupsViaGetGroups: safeCall(() => config?.getGroups?.()),
            order: safeCall(() => (config as any)?.order ?? (config as any)?._order),
            groupLookups
          }
        } catch (error) {
          return {
            intent,
            error: error instanceof Error ? error.message : String(error)
          }
        }
      }

      const optionalContentDebug = {
        markedOcgIds,
        display: await readOptionalContentConfigDebug('display'),
        any: await readOptionalContentConfigDebug('any'),
        print: await readOptionalContentConfigDebug('print')
      }
      // 3ECAD_OPTIONAL_CONTENT_DEEP_DEBUG_END
      const pdfAnalyzeReport = {
        source: '3ECAD_PDF_OPERATOR_ANALYZER',
        page: pageNumber,
        viewport: {
          width: viewport.width,
          height: viewport.height
        },
        optionalContent: optionalContentReport,
        ocgIds: markedOcgIds,
        optionalContentDebug,
        operatorCounts: analyzeOperatorCounts,
        samples: analyzeSamples,
        markedContentSamples,
        paintSequenceSamples
      }

      ;(globalThis as any).__3ECAD_PDF_ANALYZE__ = pdfAnalyzeReport

      log.info(
        `[PdfImport ANALYZE] ${JSON.stringify(pdfAnalyzeReport, null, 2).slice(
          0,
          30000
        )}`
      )
      // 3ECAD_PDF_OPERATOR_ANALYZER_END
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

      const ocgIdToLayerName = new Map<string, string>()

      try {
        const optionalContentConfig = await (pdf as any).getOptionalContentConfig?.({
          intent: 'display'
        })

        for (const id of markedOcgIds) {
          const group = optionalContentConfig?.getGroup?.(id)
          const layerName =
            typeof group?.name === 'string' && group.name.trim()
              ? group.name.trim()
              : `PDF_OCG_${id}`

          ocgIdToLayerName.set(id, layerName)
        }
      } catch (error) {
        log.warn(
          '[PdfImport] Failed to resolve OCG layer names. Falling back to OCG ids.',
          error
        )

        for (const id of markedOcgIds) {
          ocgIdToLayerName.set(id, `PDF_OCG_${id}`)
        }
      }

      const pdfLayerNames = Array.from(
        new Set(Array.from(ocgIdToLayerName.values()))
      )

      const docWithLayerService = context.doc as AcApContext['doc'] & {
        layerService?: {
          createLayers?: (names: string[]) => void
        }
      }

      docWithLayerService.layerService?.createLayers?.(pdfLayerNames)

      const layerColorCounts = new Map<string, Map<number, number>>()

      const entities = this.extractEntities(
        operatorList,
        pageHeight,
        ocgIdToLayerName,
        layerColorCounts
      )

      const actualEntityLayerNames = Array.from(
        new Set(
          entities
            .map(entity => entity.layer)
            .filter((name): name is string => typeof name === 'string' && name.trim().length > 0)
        )
      )

      docWithLayerService.layerService?.createLayers?.(actualEntityLayerNames)

      const layerColorSummary: Record<string, string> = {}

      for (const [layerName, colorCounts] of layerColorCounts) {
        const sortedColors = Array.from(colorCounts.entries()).sort(
          (a, b) => b[1] - a[1]
        )

        const rgb = sortedColors[0]?.[0]

        if (rgb == null) continue

        const colorText = `#${rgb
          .toString(16)
          .padStart(6, '0')
          .toUpperCase()}`

        const layerColor = new AcCmColor(AcCmColorMethod.ByColor, rgb)

        docWithLayerService.layerService?.setLayerColor?.(layerName, layerColor)

        layerColorSummary[layerName] = colorText
      }

      const layerColorCountsSummary: Record<string, Record<string, number>> = {}

      for (const [layerName, colorCounts] of layerColorCounts) {
        layerColorCountsSummary[layerName] = Object.fromEntries(
          Array.from(colorCounts.entries())
            .sort((a, b) => b[1] - a[1])
            .map(([rgb, count]) => [
              `#${rgb.toString(16).padStart(6, '0').toUpperCase()}`,
              count
            ])
        )
      }

      ;(globalThis as any).__3ECAD_PDF_LAYER_COLORS__ = layerColorSummary
      ;(globalThis as any).__3ECAD_PDF_LAYER_COLOR_COUNTS__ =
        layerColorCountsSummary

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

      context.doc.database.transactionManager.clearUndoStack()
      ;(globalThis as any).__3ECAD_PDF_IMPORT_UNDO_STACK_CLEARED__ = true

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
    pageHeight: number,
    ocgIdToLayerName: Map<string, string>,
    layerColorCounts: Map<string, Map<number, number>>
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
    let subpathLayers: string[] = []
    let subpathStrokeColors: number[] = []
    let subpathFillColors: number[] = []
    let subpathLineWidths: number[] = []
    let current: Point2[] = []
    let currentSubpathLayerName: string | undefined
    let currentSubpathStrokeRgb: number | undefined
    let currentSubpathFillRgb: number | undefined
    let currentSubpathLineWidth: number | undefined
    const importedEntityLayerCounts = new Map<string, number>()
    let curX = 0
    let curY = 0

    type PdfMatrix = [number, number, number, number, number, number]

    type PdfGraphicsState = {
      ctm: PdfMatrix
      strokeRgb: number
      fillRgb: number
      lineWidth: number
    }

    let graphicsState: PdfGraphicsState = {
      ctm: [1, 0, 0, 1, 0, 0],
      strokeRgb: 0x000000,
      fillRgb: 0x000000,
      lineWidth: 1
    }

    const graphicsStateStack: PdfGraphicsState[] = []
    const markedContentStack: Array<string | null> = []
    const cloneMatrix = (matrix: PdfMatrix): PdfMatrix => [
      matrix[0],
      matrix[1],
      matrix[2],
      matrix[3],
      matrix[4],
      matrix[5]
    ]

    const multiplyMatrix = (left: PdfMatrix, right: PdfMatrix): PdfMatrix => [
      left[0] * right[0] + left[2] * right[1],
      left[1] * right[0] + left[3] * right[1],
      left[0] * right[2] + left[2] * right[3],
      left[1] * right[2] + left[3] * right[3],
      left[0] * right[4] + left[2] * right[5] + left[4],
      left[1] * right[4] + left[3] * right[5] + left[5]
    ]

    const applyCtm = (x: number, y: number) => {
      const [a, b, c, d, e, f] = graphicsState.ctm

      return {
        x: a * x + c * y + e,
        y: b * x + d * y + f
      }
    }

    const clampByte = (value: number) =>
      Math.max(0, Math.min(255, Math.round(value)))

    const normalizePdfColorComponent = (value: number) =>
      value <= 1 ? clampByte(value * 255) : clampByte(value)

    const rgbFromHexString = (value: string) => {
      const normalized = value.trim()

      const match = normalized.match(/^#?([0-9a-f]{6})$/i)

      if (!match) return undefined

      return Number.parseInt(match[1], 16)
    }

    const rgbFromComponents = (
      r: number | string | undefined,
      g?: number,
      b?: number
    ) => {
      if (typeof r === 'string') {
        const parsed = rgbFromHexString(r)

        if (parsed !== undefined) {
          return parsed
        }
      }

      return (
        (normalizePdfColorComponent(Number(r ?? 0)) << 16) |
        (normalizePdfColorComponent(Number(g ?? 0)) << 8) |
        normalizePdfColorComponent(Number(b ?? 0))
      )
    }

    const rgbFromGray = (gray: number) => {
      const byte = normalizePdfColorComponent(gray)
      return (byte << 16) | (byte << 8) | byte
    }

    const rgbFromCmyk = (c: number, m: number, y: number, k: number) => {
      const cyan = c > 1 ? c / 100 : c
      const magenta = m > 1 ? m / 100 : m
      const yellow = y > 1 ? y / 100 : y
      const black = k > 1 ? k / 100 : k

      return (
        (clampByte(255 * (1 - cyan) * (1 - black)) << 16) |
        (clampByte(255 * (1 - magenta) * (1 - black)) << 8) |
        clampByte(255 * (1 - yellow) * (1 - black))
      )
    }

    const pdfLineWidthToCadLineWeight = (lineWidthPt: number) => {
      const lineWidthMm = Math.max(0, lineWidthPt * PT_TO_MM)

      const standardWeights = [
        0, 5, 9, 13, 15, 18, 20, 25, 30, 35, 40, 50, 53, 60, 70, 80, 90, 100,
        106, 120, 140, 158, 200, 211
      ]

      let best = standardWeights[0]
      let bestDistance = Math.abs(lineWidthMm * 100 - best)

      for (const weight of standardWeights) {
        const distance = Math.abs(lineWidthMm * 100 - weight)

        if (distance < bestDistance) {
          best = weight
          bestDistance = distance
        }
      }

      return best
    }

    const addLayerColorObservation = (layerName: string, rgb: number) => {
      let colorCounts = layerColorCounts.get(layerName)

      if (!colorCounts) {
        colorCounts = new Map<number, number>()
        layerColorCounts.set(layerName, colorCounts)
      }

      colorCounts.set(rgb, (colorCounts.get(rgb) ?? 0) + 1)
    }

    const getCurrentOcgId = () => {
      for (let i = markedContentStack.length - 1; i >= 0; i--) {
        const id = markedContentStack[i]
        if (id) return id
      }

      return undefined
    }

    const getCurrentLayerName = () => {
      const ocgId = getCurrentOcgId()

      if (!ocgId) return 'PDF_VECTOR'

      return ocgIdToLayerName.get(ocgId) ?? `PDF_OCG_${ocgId}`
    }

    const tx = (x: number, y: number) => applyCtm(x, y).x * PT_TO_MM
    const ty = (x: number, y: number) => (pageHeight - applyCtm(x, y).y) * PT_TO_MM

    const flush = () => {
      if (current.length > 1) {
        subpaths.push(current)
        subpathLayers.push(currentSubpathLayerName ?? getCurrentLayerName())
        subpathStrokeColors.push(currentSubpathStrokeRgb ?? graphicsState.strokeRgb)
        subpathFillColors.push(currentSubpathFillRgb ?? graphicsState.fillRgb)
        subpathLineWidths.push(currentSubpathLineWidth ?? graphicsState.lineWidth)
      }

      current = []
      currentSubpathLayerName = undefined
      currentSubpathStrokeRgb = undefined
      currentSubpathFillRgb = undefined
      currentSubpathLineWidth = undefined
    }

    const commit = (paintMode: 'stroke' | 'fill' | 'mixed' = 'stroke') => {
      flush()

      for (let spIndex = 0; spIndex < subpaths.length; spIndex++) {
        const sp = subpaths[spIndex]
        const layerName = subpathLayers[spIndex] ?? getCurrentLayerName()
        const entity = this.subpathToEntity(sp)

        if (entity) {
          const rgb =
            paintMode === 'fill'
              ? subpathFillColors[spIndex] ?? graphicsState.fillRgb
              : subpathStrokeColors[spIndex] ?? graphicsState.strokeRgb

          entity.layer = layerName
          entity.color = new AcCmColor(AcCmColorMethod.ByColor, rgb)
          entity.lineWeight = pdfLineWidthToCadLineWeight(
            subpathLineWidths[spIndex] ?? graphicsState.lineWidth
          )

          addLayerColorObservation(layerName, rgb)

          importedEntityLayerCounts.set(
            layerName,
            (importedEntityLayerCounts.get(layerName) ?? 0) + 1
          )
          result.push(entity)
        }
      }

      subpaths = []
      subpathLayers = []
      subpathStrokeColors = []
      subpathFillColors = []
      subpathLineWidths = []
    }

    const discardPath = () => {
      current = []
      subpaths = []
      subpathLayers = []
      subpathStrokeColors = []
      subpathFillColors = []
      subpathLineWidths = []
      currentSubpathLayerName = undefined
      currentSubpathStrokeRgb = undefined
      currentSubpathFillRgb = undefined
      currentSubpathLineWidth = undefined
    }

    const moveTo = (x: number, y: number) => {
      flush()
      curX = x
      curY = y
      currentSubpathLayerName = getCurrentLayerName()
      currentSubpathStrokeRgb = graphicsState.strokeRgb
      currentSubpathFillRgb = graphicsState.fillRgb
      currentSubpathLineWidth = graphicsState.lineWidth
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
      _minMax?: ArrayLike<number>
    ) => {
      let index = 0

      // Coordinates are transformed by the current PDF CTM.
      // Do not apply the old x100 heuristic here, otherwise paths get double-scaled.
      const take = () => Number(packedStream[index++])

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
        case OPS.save: {
          graphicsStateStack.push({
            ctm: cloneMatrix(graphicsState.ctm),
            strokeRgb: graphicsState.strokeRgb,
            fillRgb: graphicsState.fillRgb,
            lineWidth: graphicsState.lineWidth
          })
          break
        }

        case OPS.restore: {
          const restoredState = graphicsStateStack.pop()

          if (restoredState) {
            graphicsState = restoredState
          }

          break
        }

        case OPS.transform: {
          const args = rawArgs as number[]

          if (Array.isArray(args) && args.length >= 6) {
            graphicsState.ctm = multiplyMatrix(graphicsState.ctm, [
              Number(args[0]),
              Number(args[1]),
              Number(args[2]),
              Number(args[3]),
              Number(args[4]),
              Number(args[5])
            ])
          }

          break
        }

        case OPS.beginMarkedContent: {
          markedContentStack.push(null)
          break
        }

        case OPS.beginMarkedContentProps: {
          const args = rawArgs as any[]
          const tag = args?.[0]
          const properties = args?.[1]

          if (tag === 'OC' && properties?.id) {
            markedContentStack.push(String(properties.id))
          } else {
            markedContentStack.push(null)
          }

          break
        }

        case OPS.endMarkedContent: {
          if (markedContentStack.length > 0) {
            markedContentStack.pop()
          }

          break
        }

        case OPS.clip:
        case OPS.eoClip: {
          break
        }

        // 3ECAD_PDF_COLOR_OPERATOR_CASES_START
        case OPS.setStrokeRGBColor: {
          const args = rawArgs as number[]
          graphicsState.strokeRgb = rgbFromComponents(args[0], args[1], args[2])
          break
        }

        case OPS.setFillRGBColor: {
          const args = rawArgs as Array<number | string>
          graphicsState.fillRgb = rgbFromComponents(
            args[0],
            args[1] as number | undefined,
            args[2] as number | undefined
          )
          break
        }

        case OPS.setStrokeGray: {
          const args = rawArgs as number[]
          graphicsState.strokeRgb = rgbFromGray(args[0])
          break
        }

        case OPS.setFillGray: {
          const args = rawArgs as number[]
          graphicsState.fillRgb = rgbFromGray(args[0])
          break
        }

        case OPS.setStrokeCMYKColor: {
          const args = rawArgs as number[]
          graphicsState.strokeRgb = rgbFromCmyk(args[0], args[1], args[2], args[3])
          break
        }

        case OPS.setFillCMYKColor: {
          const args = rawArgs as number[]
          graphicsState.fillRgb = rgbFromCmyk(args[0], args[1], args[2], args[3])
          break
        }

        case OPS.setLineWidth: {
          const args = rawArgs as number[]
          graphicsState.lineWidth = Number(args?.[0] ?? graphicsState.lineWidth)
          break
        }
        // 3ECAD_PDF_COLOR_OPERATOR_CASES_END

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
        case OPS.closeStroke: {
          commit('stroke')
          break
        }

        case OPS.fill:
        case OPS.eoFill: {
          commit('fill')
          break
        }

        case OPS.fillStroke:
        case OPS.eoFillStroke:
        case OPS.closeFillStroke:
        case OPS.closeEOFillStroke: {
          commit('mixed')
          break
        }

        case OPS.endPath: {
          discardPath()
          break
        }
      }
    }

    commit()
    ;(globalThis as any).__3ECAD_PDF_LAYER_ENTITY_COUNTS__ = Object.fromEntries(importedEntityLayerCounts)
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

























