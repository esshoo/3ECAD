import { AcGiLineWeight } from '@mlightcad/data-model'

export function localizeLineTypeLabel(
  value: string,
  label: string,
  locale: string
) {
  if (locale !== 'ar') return label

  switch (value.trim().toLowerCase()) {
    case 'bylayer':
      return 'حسب الطبقة'

    case 'byblock':
      return 'حسب الكتلة'

    case 'continuous':
      return 'متصل'

    default:
      return label
  }
}

export function formatLineWeightLabel(
  value: number,
  locale: string
) {
  switch (value) {
    case AcGiLineWeight.ByLayer:
      return locale === 'ar'
        ? 'حسب الطبقة'
        : 'ByLayer'

    case AcGiLineWeight.ByBlock:
      return locale === 'ar'
        ? 'حسب الكتلة'
        : 'ByBlock'

    case AcGiLineWeight.ByLineWeightDefault:
      return locale === 'ar'
        ? 'افتراضي'
        : 'Default'

    default:
      return `${(value / 100).toFixed(2)} mm`
  }
}

export function lineWeightPreviewPx(
  value: number
): number | null {
  if (value < 0) return null

  return Math.max(
    1,
    Math.min(6, value / 40)
  )
}