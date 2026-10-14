// Every word quackpit shows, in English, Korean, Japanese, and Chinese in
// its simplified and traditional (Taiwan) forms: a table each in locales/,
// every other table typed against the English one's keys, so a missing
// translation fails `tsc`. Units (5h, 1.2M, $0.42) and command names stay as
// they are in every language, and so does "Quack:", quackpit's own word.

import { EN, type Key } from './locales/en'
import { JA } from './locales/ja'
import { KO } from './locales/ko'
import { ZH_HANS } from './locales/zh-hans'
import { ZH_HANT } from './locales/zh-hant'

export type { Key }

export const LOCALES = ['en', 'ko', 'ja', 'zh-Hans', 'zh-Hant'] as const
export type Locale = (typeof LOCALES)[number]

const TABLES: Record<Locale, Record<Key, string>> = { en: EN, ko: KO, ja: JA, 'zh-Hans': ZH_HANS, 'zh-Hant': ZH_HANT }

export type Params = Readonly<Record<string, string | number>>

export function t(locale: Locale, key: Key, params: Params = {}): string {
  const template = TABLES[locale]?.[key] ?? EN[key]
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => (name in params ? String(params[name]) : whole))
}

export function isLocale(x: unknown): x is Locale {
  return typeof x === 'string' && (LOCALES as readonly string[]).includes(x)
}

/**
 * `auto` follows the system locale: Korean for ko, Japanese for ja,
 * Simplified Chinese for zh-CN, zh-SG and zh-Hans, Traditional for zh-TW,
 * zh-HK, zh-MO and zh-Hant; anything else, English. A bare `zh` reads as
 * Simplified, the form most of its speakers write.
 */
export function resolveLocale(setting: unknown, systemLocale: string | undefined): Locale {
  if (isLocale(setting)) return setting
  const tag = (systemLocale ?? '').replace(/_/g, '-').toLowerCase()
  const [lang = '', ...rest] = tag.split(/[-.@]/)
  if (lang === 'ko') return 'ko'
  if (lang === 'ja') return 'ja'
  if (lang === 'zh') {
    if (rest.includes('hant') || rest.some(part => part === 'tw' || part === 'hk' || part === 'mo')) return 'zh-Hant'
    return 'zh-Hans'
  }
  return 'en'
}

/** The system locale as the environment reports it, if it does. */
export function systemLocale(): string | undefined {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return undefined
  }
}

/** `2nd`, `3rd`; `두 번째`; `2回目`; `第2次`: the AI's answers counted. */
export function ordinal(n: number, L: Locale): string {
  if (L === 'ko') return ['첫 번째', '두 번째', '세 번째', '네 번째', '다섯 번째'][n - 1] ?? `${n}번째`
  if (L === 'ja') return `${n}回目`
  if (L === 'zh-Hans' || L === 'zh-Hant') return `第${n}次`
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][n % 10] ?? 'th')
  return `${n}${tail}`
}
