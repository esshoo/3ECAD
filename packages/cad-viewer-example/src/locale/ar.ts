export default {
  command: {
    ACAD: {
      TEXTSCALE: {
        description: 'تغيير مقياس كل النصوص في الملف المفتوح'
      },
      LABELSCALE: {
        description: 'تغيير مقياس نصوص التسميات والأسماء'
      },
      NUMSCALE: {
        description: 'تغيير مقياس نصوص الأرقام والأبعاد'
      },
      TEXTRESET: {
        description: 'إعادة إعدادات النصوص للقيم الافتراضية'
      }
    }
  },
  threeEcad: {
    commands: {
      textScale: {
        prompt: 'ادخل مقياس النصوص',
        invalid: 'قيمة المقياس غير صحيحة.',
        current: 'مقياس النصوص: التسميات={labels}, الأرقام={numbers}'
      },
      labelScale: {
        prompt: 'ادخل مقياس التسميات'
      },
      numberScale: {
        prompt: 'ادخل مقياس الأرقام'
      },
      textReset: {
        done: 'تمت إعادة إعدادات النصوص.'
      }
    }
  }
}
