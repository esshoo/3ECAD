import {
  AcApDocManager,
  AcApI18n,
  AcEdCommand,
  AcEdPromptStatus,
  AcEdPromptStringOptions
} from '@mlightcad/cad-simple-viewer'
import {
  getThreeEcadTextSettings,
  resetThreeEcadTextSettings,
  saveThreeEcadTextSettings
} from '@mlightcad/cad-pdf-plugin'

const t = (key: string, fallback: string) => {
  const value = AcApI18n.t(key)
  return value && value !== key ? value : fallback
}

const formatSettingsMessage = () => {
  const settings = getThreeEcadTextSettings()

  return t(
    'threeEcad.commands.textScale.current',
    `Text scale: labels=${settings.textLabelScale}, numbers=${settings.textNumberScale}`
  )
    .replace('{labels}', String(settings.textLabelScale))
    .replace('{numbers}', String(settings.textNumberScale))
}

const readScale = async (promptKey: string, fallbackPrompt: string) => {
  const prompt = new AcEdPromptStringOptions(t(promptKey, fallbackPrompt))
  const result = await AcApDocManager.instance.editor.getString(prompt)

  if (result.status !== AcEdPromptStatus.OK || !result.stringResult) {
    return undefined
  }

  const value = Number(result.stringResult)

  if (!Number.isFinite(value) || value <= 0) {
    AcApDocManager.instance.editor.showMessage(
      t('threeEcad.commands.textScale.invalid', 'Invalid scale value.'),
      'warning'
    )
    return undefined
  }

  return value
}

export class ThreeEcadTextScaleCmd extends AcEdCommand {
  async execute() {
    const value = await readScale(
      'threeEcad.commands.textScale.prompt',
      'Enter text scale'
    )

    if (value == null) return

    saveThreeEcadTextSettings({
      textLabelScale: value,
      textNumberScale: value
    })

    AcApDocManager.instance.editor.showMessage(formatSettingsMessage(), 'info')
  }
}

export class ThreeEcadLabelScaleCmd extends AcEdCommand {
  async execute() {
    const value = await readScale(
      'threeEcad.commands.labelScale.prompt',
      'Enter label text scale'
    )

    if (value == null) return

    saveThreeEcadTextSettings({
      textLabelScale: value
    })

    AcApDocManager.instance.editor.showMessage(formatSettingsMessage(), 'info')
  }
}

export class ThreeEcadNumberScaleCmd extends AcEdCommand {
  async execute() {
    const value = await readScale(
      'threeEcad.commands.numberScale.prompt',
      'Enter number text scale'
    )

    if (value == null) return

    saveThreeEcadTextSettings({
      textNumberScale: value
    })

    AcApDocManager.instance.editor.showMessage(formatSettingsMessage(), 'info')
  }
}

export class ThreeEcadTextResetCmd extends AcEdCommand {
  async execute() {
    resetThreeEcadTextSettings()

    AcApDocManager.instance.editor.showMessage(
      t('threeEcad.commands.textReset.done', 'Text settings reset.'),
      'info'
    )
  }
}
