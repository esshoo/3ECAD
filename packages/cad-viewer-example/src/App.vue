<template>
  <div id="app-root">
    <!-- Upload screen when no drawing is open -->
    <div v-if="!showViewer" class="upload-screen">
      <FileUpload
        @file-select="handleFileSelect"
        @new-drawing="handleNewDrawing"
      />
    </div>

    <!-- CAD viewer when a file is selected or a new drawing is created -->
    <div v-else>
      <MlCadViewer
        locale="default"
        :local-file="store.selectedFile ?? undefined"
        :mode="selectedMode"
        :use-main-thread-draw="useMainThreadDraw"
        :draw-no-plot-layers="drawNoPlotLayers"
        :progressive-rendering="progressiveRendering"
        :open-view-mode="openViewMode"
        @create="onViewerCreate"
        :base-url="BASE_URL"
      />

      <Teleport v-if="pdfPageCount > 1" to=".ml-pdf-page-tabs-host">
        <button
          v-for="pageNumber in pdfPageCount"
          :key="pageNumber"
          type="button"
          class="el-button ml-status-bar-layout-button pdf-page-layout-button"
          :class="{ 'el-button--primary': pageNumber === currentPdfPage }"
          :disabled="isPdfPageLoading"
          @click="switchPdfPage(pageNumber)"
        >
          <span>{{ t('example.pdf.page', { page: pageNumber }) }}</span>
        </button>
      </Teleport>
    </div>
  </div>
</template>

<script setup lang="ts">
// import { AcApSettingManager } from '@mlightcad/cad-simple-viewer'
import {
  AcApDocManager,
  AcApOpenViewMode,
  AcEdCommandStack,
  AcEdOpenMode,
  acapUpdateOpenFileDialogOptions,
  type AcApContext
} from '@mlightcad/cad-simple-viewer'
import { MlCadViewer } from '@mlightcad/cad-viewer'
import { AcApPdfImportConvertor } from '@mlightcad/cad-pdf-plugin'
import { log } from '@mlightcad/data-model'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'

import { AcApQuitCmd, registerThreeEcadCommands } from './commands'
import FileUpload from './components/FileUpload.vue'
import { initializeLocale } from './locale'
import { store } from './store'

initializeLocale()

const { t } = useI18n({ useScope: 'global' })

const zoomToFitAfterOpen = async () => {
  await nextTick()

  const delays = [100, 300, 800, 1500]

  for (const delay of delays) {
    window.setTimeout(() => {
      AcApDocManager.instance.context?.view?.zoomToFitDrawing?.()
    }, delay)
  }
}
const initialize = () => {
  if (import.meta.env.DEV) {
    ;(
      window as Window & { AcApDocManager?: typeof AcApDocManager }
    ).AcApDocManager = AcApDocManager
  }
  const register = AcApDocManager.instance.commandManager
  register.addCommand(
    AcEdCommandStack.SYSTEMT_COMMAND_GROUP_NAME,
    'quit',
    'quit',
    new AcApQuitCmd()
  )
  register.addCommand(
    AcEdCommandStack.SYSTEMT_COMMAND_GROUP_NAME,
    'exit',
    'exit',
    new AcApQuitCmd()
  )
  registerThreeEcadCommands(register)
}

// Decide whether to show command line vertical toolbar at the right side,
// performance stats, coordinates in status bar, etc.
// AcApSettingManager.instance.isShowCommandLine = false
// AcApSettingManager.instance.isShowToolbar = false
// AcApSettingManager.instance.isShowStats = false
// AcApSettingManager.instance.isShowCoordinate = false

const BASE_URL = 'https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/'

const showViewer = computed(
  () => store.selectedFile != null || store.isNewDrawing
)

watch(
  () => store.selectedFile,
  file => {
    if (file) {
      void zoomToFitAfterOpen()
    }
  }
)

const selectedMode = ref<AcEdOpenMode>(AcEdOpenMode.Write)
const useMainThreadDraw = ref(false)
const drawNoPlotLayers = ref(false)
const progressiveRendering = ref(false)
const openViewMode = ref<AcApOpenViewMode | undefined>(undefined)
const pendingPdfFile = ref<File | null>(null)
const currentPdfFile = ref<File | null>(null)
const pdfPageCount = ref(0)
const currentPdfPage = ref(1)
const isPdfPageLoading = ref(false)

const handlePdfLayoutTabsWheel = (event: WheelEvent) => {
  const target = event.target as HTMLElement | null
  const tabGroup = target?.closest?.('.ml-pdf-page-tabs-host') as
    | HTMLElement
    | null

  if (!tabGroup) return
  if (tabGroup.scrollWidth <= tabGroup.clientWidth) return

  event.preventDefault()
  tabGroup.scrollLeft += event.deltaY || event.deltaX
}

onMounted(() => {
  window.addEventListener('wheel', handlePdfLayoutTabsWheel, {
    passive: false
  })
})

onBeforeUnmount(() => {
  window.removeEventListener('wheel', handlePdfLayoutTabsWheel)
})

const createNewDrawing = async (): Promise<boolean> => {
  const success = await AcApDocManager.instance.newDocument({
    mode: selectedMode.value,
    drawNoPlotLayers: drawNoPlotLayers.value,
    progressiveRendering: progressiveRendering.value,
    ...(openViewMode.value != null ? { openViewMode: openViewMode.value } : {})
  })
  if (!success) {
    log.error('Failed to create new drawing')
  }
  return success
}

type MaybeDocManagerContext = {
  context?: AcApContext
  appContext?: AcApContext
  currentContext?: AcApContext
  _context?: AcApContext
}

const getCurrentContext = (
  eventContext?: AcApContext
): AcApContext | undefined => {
  if (eventContext) {
    return eventContext
  }

  const manager = AcApDocManager.instance as unknown as MaybeDocManagerContext
  return (
    manager.context ??
    manager.appContext ??
    manager.currentContext ??
    manager._context
  )
}

const isPdfFile = (file: File): boolean =>
  file.name.toLowerCase().endsWith('.pdf')

const getPdfPageCount = async (file: File): Promise<number> => {
  const buffer = await file.arrayBuffer()
  const convertor = new AcApPdfImportConvertor()

  return convertor.getPageCount(buffer)
}

const importPdfIntoCurrentDrawing = async (
  file: File,
  eventContext?: AcApContext,
  pageNumber = 1
): Promise<boolean> => {
  const context = getCurrentContext(eventContext)

  if (!context) {
    log.error('[PdfImport] Failed: AcApContext is not available.')
    return false
  }

  const buffer = await file.arrayBuffer()
  const convertor = new AcApPdfImportConvertor()
  await convertor.convert(context, buffer, pageNumber)

  await zoomToFitAfterOpen()
  return true
}

const openPdfIntoCurrentDrawing = async (
  file: File,
  eventContext?: AcApContext
) => {
  currentPdfFile.value = file
  currentPdfPage.value = 1
  pdfPageCount.value = Math.max(1, await getPdfPageCount(file))

  await importPdfIntoCurrentDrawing(file, eventContext, 1)
}

const switchPdfPage = async (pageNumber: number) => {
  if (!currentPdfFile.value) return
  if (isPdfPageLoading.value) return
  if (pageNumber === currentPdfPage.value) return
  if (pageNumber < 1 || pageNumber > pdfPageCount.value) return

  isPdfPageLoading.value = true

  try {
    const success = await createNewDrawing()
    if (!success) return

    await nextTick()

    const imported = await importPdfIntoCurrentDrawing(
      currentPdfFile.value,
      undefined,
      pageNumber
    )

    if (imported) {
      currentPdfPage.value = pageNumber
    }
  } finally {
    isPdfPageLoading.value = false
  }
}

const onViewerCreate = async (eventContext?: AcApContext) => {
  initialize()

  acapUpdateOpenFileDialogOptions({
    onFileSelected: async file => {
      if (!isPdfFile(file)) {
        return false
      }

      const success = await createNewDrawing()
      if (!success) {
        return true
      }

      await nextTick()
      await openPdfIntoCurrentDrawing(file)
      return true
    }
  })

  if (store.isNewDrawing) {
    await nextTick()
    const success = await createNewDrawing()
    if (!success) return
  }

  if (pendingPdfFile.value) {
    await nextTick()
    const file = pendingPdfFile.value
    pendingPdfFile.value = null
    await openPdfIntoCurrentDrawing(file, eventContext)
  }
}

const applyOpenOptions = (
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined
) => {
  selectedMode.value = mode
  useMainThreadDraw.value = mainThreadDraw
  drawNoPlotLayers.value = showNoPlotLayers
  progressiveRendering.value = enableProgressiveRendering
  openViewMode.value = viewMode
}

// Handle file selection from upload component
const handleFileSelect = (
  file: File,
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined
) => {
  applyOpenOptions(
    mode,
    mainThreadDraw,
    showNoPlotLayers,
    enableProgressiveRendering,
    viewMode
  )

  if (isPdfFile(file)) {
    pendingPdfFile.value = file
    currentPdfFile.value = file
    pdfPageCount.value = 0
    currentPdfPage.value = 1
    store.selectedFile = null
    store.isNewDrawing = true
    return
  }

  pendingPdfFile.value = null
  currentPdfFile.value = null
  pdfPageCount.value = 0
  currentPdfPage.value = 1
  store.isNewDrawing = false
  store.selectedFile = file
}

const handleNewDrawing = (
  mode: AcEdOpenMode,
  mainThreadDraw: boolean,
  showNoPlotLayers: boolean,
  enableProgressiveRendering: boolean,
  viewMode: AcApOpenViewMode | undefined
) => {
  pendingPdfFile.value = null
  currentPdfFile.value = null
  pdfPageCount.value = 0
  currentPdfPage.value = 1
  store.selectedFile = null
  store.isNewDrawing = true
  applyOpenOptions(
    mode,
    mainThreadDraw,
    showNoPlotLayers,
    enableProgressiveRendering,
    viewMode
  )
}
</script>

<style scoped>
#app-root {
  height: 100vh;
  position: fixed;
}

.upload-screen {
  height: 100vh;
  width: 100vw;
  display: flex;
  justify-content: center;
  align-items: safe center;
  overflow-y: auto;
  background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
  margin: 0;
  padding: 16px;
  box-sizing: border-box;
  position: absolute;
  top: 0;
  left: 0;
  z-index: 1000;
  pointer-events: auto; /* Allow clicks on upload screen */
}
</style>





<style scoped>
.pdf-page-layout-button {
  margin-left: 0;
}
</style>

<style>
/* PDF_LAYOUT_TABS_HIDDEN_SCROLL_START */
.ml-status-bar-left {
  min-width: 0;
  overflow: hidden;
}

.ml-pdf-page-tabs-host {
  max-width: min(72vw, calc(100vw - 420px));
  overflow-x: auto;
  overflow-y: hidden;
  display: flex;
  flex-wrap: nowrap;
  scrollbar-width: none;
  -ms-overflow-style: none;
  touch-action: pan-x;
  overscroll-behavior-x: contain;
}

.ml-pdf-page-tabs-host::-webkit-scrollbar {
  display: none;
}

.ml-pdf-page-tabs-host .ml-status-bar-layout-button,
.ml-pdf-page-tabs-host .pdf-page-layout-button {
  flex: 0 0 auto;
}
/* PDF_LAYOUT_TABS_HIDDEN_SCROLL_END */
</style>






