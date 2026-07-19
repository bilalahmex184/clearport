import * as React from "react"

const MOBILE_BREAKPOINT = 768

export function useIsMobile() {
  // Lazy initializer — check window.innerWidth at first render, not in a
  // mount effect. This avoids a setState-in-effect (double render) and
  // prevents a flash of the wrong value on initial load.
  const [isMobile, setIsMobile] = React.useState<boolean>(() => {
    if (typeof window !== 'undefined') {
      return window.innerWidth < MOBILE_BREAKPOINT
    }
    return false
  })

  React.useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT - 1}px)`)
    const onChange = () => {
      setIsMobile(window.innerWidth < MOBILE_BREAKPOINT)
    }
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [])

  return isMobile
}
