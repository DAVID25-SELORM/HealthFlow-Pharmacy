// Serves the web app's index page for any browser route the server does not know about
// (so refreshing /inventory or opening a bookmarked page works), and leaves /api/ alone.
//
// The route uses a regular expression, not the string '*': Express 5 rejects a bare '*'
// ("Missing parameter name") and the server would not start. A regular expression works
// the same on Express 4 and Express 5.
export const registerSpaFallback = (app, frontendIndex) => {
  app.get(/.*/, (request, response, next) => {
    if (request.path.startsWith('/api/')) {
      next()
      return
    }

    response.setHeader('Cache-Control', 'no-store')
    response.sendFile(frontendIndex)
  })
}
