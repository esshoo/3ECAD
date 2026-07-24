import { AcEdCommandStack } from '@mlightcad/cad-simple-viewer'

import {
  ThreeEcadLabelScaleCmd,
  ThreeEcadNumberScaleCmd,
  ThreeEcadTextResetCmd,
  ThreeEcadTextScaleCmd
} from './threeEcadTextScaleCmd'

export const registerThreeEcadCommands = (
  commandManager: AcEdCommandStack
) => {
  const group = AcEdCommandStack.SYSTEMT_COMMAND_GROUP_NAME

  commandManager.addCommand(
    group,
    'TEXTSCALE',
    'TEXTSCALE',
    new ThreeEcadTextScaleCmd(),
    ['TS', 'نص', 'حجم_النص']
  )

  commandManager.addCommand(
    group,
    'LABELSCALE',
    'LABELSCALE',
    new ThreeEcadLabelScaleCmd(),
    ['LS', 'تسميات', 'تسمية', 'حجم_التسميات']
  )

  commandManager.addCommand(
    group,
    'NUMSCALE',
    'NUMSCALE',
    new ThreeEcadNumberScaleCmd(),
    ['NS', 'ارقام', 'أرقام', 'حجم_الارقام', 'حجم_الأرقام']
  )

  commandManager.addCommand(
    group,
    'TEXTRESET',
    'TEXTRESET',
    new ThreeEcadTextResetCmd(),
    ['اعادة_النص', 'إعادة_النص']
  )
}
