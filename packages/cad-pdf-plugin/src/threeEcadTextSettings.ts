export interface ThreeEcadTextSettings {
  textLabelScale: number
  textNumberScale: number
  textImportEnabled: boolean
  imageImportEnabled: boolean
}

const STORAGE_KEY = '3ecad.text.settings.v1'

export const DEFAULT_THREE_ECAD_TEXT_SETTINGS: ThreeEcadTextSettings = {
  textLabelScale: 0.45,
  textNumberScale: 0.75,
  textImportEnabled: true,
  imageImportEnabled: true
}

const clampScale = (value: unknown, fallback: number) => {
  const parsed = Number(value)

  if (!Number.isFinite(parsed)) return fallback

  return Math.min(10, Math.max(0.01, parsed))
}

const canUseLocalStorage = () => {
  try {
    return typeof globalThis !== 'undefined' && 'localStorage' in globalThis
  } catch {
    return false
  }
}

export const getThreeEcadTextSettings = (): ThreeEcadTextSettings => {
  if (!canUseLocalStorage()) {
    return { ...DEFAULT_THREE_ECAD_TEXT_SETTINGS }
  }

  try {
    const raw = globalThis.localStorage.getItem(STORAGE_KEY)
    const parsed = raw ? JSON.parse(raw) : {}

    return {
      textLabelScale: clampScale(
        parsed.textLabelScale,
        DEFAULT_THREE_ECAD_TEXT_SETTINGS.textLabelScale
      ),
      textNumberScale: clampScale(
        parsed.textNumberScale,
        DEFAULT_THREE_ECAD_TEXT_SETTINGS.textNumberScale
      ),
      textImportEnabled:
        typeof parsed.textImportEnabled === 'boolean'
          ? parsed.textImportEnabled
          : DEFAULT_THREE_ECAD_TEXT_SETTINGS.textImportEnabled,
      imageImportEnabled:
        typeof parsed.imageImportEnabled === 'boolean'
          ? parsed.imageImportEnabled
          : DEFAULT_THREE_ECAD_TEXT_SETTINGS.imageImportEnabled
    }
  } catch {
    return { ...DEFAULT_THREE_ECAD_TEXT_SETTINGS }
  }
}

export const saveThreeEcadTextSettings = (
  nextSettings: Partial<ThreeEcadTextSettings>
): ThreeEcadTextSettings => {
  const current = getThreeEcadTextSettings()

  const merged: ThreeEcadTextSettings = {
    ...current,
    ...nextSettings,
    textLabelScale: clampScale(
      nextSettings.textLabelScale ?? current.textLabelScale,
      DEFAULT_THREE_ECAD_TEXT_SETTINGS.textLabelScale
    ),
    textNumberScale: clampScale(
      nextSettings.textNumberScale ?? current.textNumberScale,
      DEFAULT_THREE_ECAD_TEXT_SETTINGS.textNumberScale
    )
  }

  if (canUseLocalStorage()) {
    globalThis.localStorage.setItem(STORAGE_KEY, JSON.stringify(merged))
  }

  return merged
}

export const resetThreeEcadTextSettings = (): ThreeEcadTextSettings => {
  if (canUseLocalStorage()) {
    globalThis.localStorage.removeItem(STORAGE_KEY)
  }

  return { ...DEFAULT_THREE_ECAD_TEXT_SETTINGS }
}
