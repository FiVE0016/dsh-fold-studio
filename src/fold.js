// Settings shared by the browser and the host panels. No DOM access.
export const ROOT_ATTRIBUTE = 'data-dsh-bubble-fold'
export const STYLE_ID = 'dsh-bubble-fold-styles'
export const STORAGE_KEY = 'dsh.bubble-fold.settings'
export const SETTINGS_VERSION = 2
export const LIMITS = Object.freeze({
  minLines: 1,
  maxLines: 120,
  minRightbarRatio: 30,
  maxRightbarRatio: 70,
})
export const DEFAULT_SETTINGS = Object.freeze({
  enabled: true,
  userEnabled: true,
  assistantEnabled: true,
  userLines: 3,
  assistantLines: 3,
  extraPx: 6,
  collapseAll: false,
  collapsedLines: 3,
  keepLatestOpen: true,
  foldAllSteps: true,
  workStepButtons: true,
  composerResize: true,
  mergeByDefault: true,
  stepLabels: false,
  turnTimer: true,
  rightbarRatio: 45,
  // While a turn is generating, the host keeps each thinking/tool row collapsed
  // to a one-line summary. Opt in to have the plugin open them so the whole
  // process is readable, then they merge again when the turn ends. Off by
  // default: expanding every tool row costs layout and is not for everyone.
  expandLive: false,
  // The host loads earlier history as soon as the transcript is scrolled near
  // its top. Some readers want that to be an explicit choice, so the plugin can
  // park the host's own "load older" row out of view and re-expose it as a
  // button the reader presses.
  manualHistory: true,
})
const integer = (value, min, max, fallback) => {
  const number =
    typeof value === 'number' || (typeof value === 'string' && value.trim())
      ? Number(value)
      : NaN
  return Number.isFinite(number)
    ? Math.min(max, Math.max(min, Math.round(number)))
    : fallback
}
export function normalizeSettings(input) {
  const raw =
    input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  const result = { ...DEFAULT_SETTINGS }
  for (const [key, fallback] of Object.entries(DEFAULT_SETTINGS)) {
    if (typeof fallback === 'boolean' && typeof raw[key] === 'boolean')
      result[key] = raw[key]
  }
  for (const key of ['userLines', 'assistantLines'])
    result[key] = integer(raw[key], 1, 120, DEFAULT_SETTINGS[key])
  result.collapsedLines = integer(
    raw.collapsedLines,
    1,
    60,
    DEFAULT_SETTINGS.collapsedLines,
  )
  result.extraPx = integer(raw.extraPx, 0, 120, DEFAULT_SETTINGS.extraPx)
  result.rightbarRatio = integer(
    raw.rightbarRatio,
    30,
    70,
    DEFAULT_SETTINGS.rightbarRatio,
  )
  return result
}
/** Upgrade the former 6/10 defaults once; retain other explicit preferences. */
export function migrateSettings(input) {
  const raw = input && typeof input === 'object' ? { ...input } : {}
  // 1.0.0/1.0.1 enabled labels by default. Restore the original icon buttons once.
  if (raw.schemaVersion === 1) raw.stepLabels = false
  if (!raw.schemaVersion) {
    if (raw.userLines === 6) raw.userLines = 3
    if (raw.assistantLines === 10) raw.assistantLines = 3
  }
  return normalizeSettings(raw)
}
export function shouldFold({
  totalLines,
  budget,
  enabled,
  streaming,
  latest,
  settings,
  choice,
}) {
  if (!enabled || streaming || totalLines <= budget) return false
  if (typeof choice === 'boolean') return !choice
  return settings.collapseAll || !(latest && settings.keepLatestOpen)
}
