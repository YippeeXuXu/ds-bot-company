import { t } from './i18n.js'

// Waiting time in the same words the to-do page uses: "12 分钟" up to an hour, then
// "2 小时 5 分". Shared so the drawer's pending rows cannot drift from the page.
export const waitText = value => {
  const total = Math.max(0, Math.round(Number(value) || 0))
  if (total < 60) return `${total} ${t('min')}`
  const hours = Math.floor(total / 60)
  const rest = total % 60
  return rest ? `${hours} ${t('h')} ${rest} ${t('min')}` : `${hours} ${t('h')}`
}
