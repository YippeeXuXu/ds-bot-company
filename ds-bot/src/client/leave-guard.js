// A screen with unsaved edits registers here, so every way out can ask first.
// The guard returns true when it took the request over and will resume it.
let guard = null

export const installLeaveGuard = check => {
  guard = check
  return () => { if (guard === check) guard = null }
}

export const askLeave = proceed => Boolean(guard?.(proceed))
