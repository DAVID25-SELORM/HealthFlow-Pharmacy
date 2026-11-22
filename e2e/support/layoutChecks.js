// Reusable "does this screen still look sane" checks. Each returns a list of
// plain-language problems; an empty list means the screen is fine.

// Anything that is wider than the screen with no scrolling box around it.
export const findOffScreenProblems = (page) =>
  page.evaluate(() => {
    const viewportWidth = document.documentElement.clientWidth
    const problems = []

    if (document.documentElement.scrollWidth > viewportWidth + 1) {
      problems.push(
        `The page scrolls sideways (content is ${document.documentElement.scrollWidth}px wide on a ${viewportWidth}px screen).`
      )
    }

    const isClippedByScrollBox = (element) => {
      for (let parent = element.parentElement; parent && parent !== document.body; parent = parent.parentElement) {
        const { overflowX } = getComputedStyle(parent)
        if (['auto', 'scroll', 'hidden', 'clip'].includes(overflowX)) {
          const box = parent.getBoundingClientRect()
          if (box.right <= viewportWidth + 1 && box.left >= -1) return true
        }
      }
      return false
    }

    const describe = (element) => {
      const text = (element.innerText || element.getAttribute('aria-label') || '').trim().replace(/\s+/g, ' ').slice(0, 40)
      return `<${element.tagName.toLowerCase()}${element.className && typeof element.className === 'string' ? '.' + element.className.trim().split(/\s+/)[0] : ''}> "${text}"`
    }

    const candidates = document.querySelectorAll('.page-content button, .page-content a[href], .page-content input, .page-content select, .page-content textarea, .topbar button, .topbar a, .topbar input')
    for (const element of candidates) {
      const style = getComputedStyle(element)
      if (style.display === 'none' || style.visibility === 'hidden') continue
      const box = element.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) continue
      if ((box.right > viewportWidth + 1 || box.left < -1) && !isClippedByScrollBox(element)) {
        problems.push(`${describe(element)} sits partly off the screen (${Math.round(box.left)}px to ${Math.round(box.right)}px on a ${viewportWidth}px screen).`)
      }
    }

    return problems.slice(0, 8)
  })

// A floating panel (bell list, more menu, dialog) must sit fully inside the screen.
export const findPanelProblems = async (page, selector, label) => {
  const box = await page.locator(selector).first().boundingBox()
  if (!box) return [`${label} did not appear.`]
  const viewport = page.viewportSize()
  const problems = []
  if (box.x < -1) problems.push(`${label} is cut off on the left (starts at ${Math.round(box.x)}px).`)
  if (box.x + box.width > viewport.width + 1) {
    problems.push(`${label} is cut off on the right (ends at ${Math.round(box.x + box.width)}px on a ${viewport.width}px screen).`)
  }
  if (box.y < -1) problems.push(`${label} is cut off at the top.`)
  if (box.y + box.height > viewport.height + 1) {
    problems.push(`${label} runs below the bottom of the screen (ends at ${Math.round(box.y + box.height)}px on a ${viewport.height}px screen).`)
  }
  return problems
}

// The last thing on a long page must be reachable, not hidden behind the bottom bar.
export const findHiddenBehindBottomBar = (page) =>
  page.evaluate(() => {
    const bar = document.querySelector('.bottom-nav')
    const content = document.querySelector('.page-content')
    if (!bar || !content || getComputedStyle(bar).display === 'none') return []
    const barHeight = bar.getBoundingClientRect().height
    const padding = parseFloat(getComputedStyle(content).paddingBottom) || 0
    return padding + 1 >= barHeight
      ? []
      : [`The bottom bar (${Math.round(barHeight)}px tall) can cover the end of the page; only ${Math.round(padding)}px of space is kept clear.`]
  })
