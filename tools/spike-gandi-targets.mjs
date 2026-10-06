import { listTargets, CdpConnection, evaluate } from '../src/bridge/cdp.mjs'

const PORT = Number(process.env.PORT ?? 9222)
const targets = await listTargets(PORT)
console.log('targets:', targets.map((t) => `${t.type} ${t.title} ${t.url}`))

for (const t of targets) {
  if (!t.webSocketDebuggerUrl) continue
  const conn = await CdpConnection.connect(t.webSocketDebuggerUrl)
  const info = await evaluate(conn, `JSON.stringify({
    href: location.href,
    origin: location.origin,
    title: document.title,
    globals: ['vm','ScratchBlocks','ReduxStore','GandiEditorPreload','ViewPreload','EventsPreload','SettingsPreload','ccwDesktop','CommonPreload','PromptsPreload']
      .filter((k) => typeof window[k] !== 'undefined'),
    localStorageKeys: Object.keys(localStorage),
    sessionKeys: Object.keys(sessionStorage),
    rootHtmlLen: document.getElementById('root')?.innerHTML.length ?? -1,
    bodyText: (document.body.innerText || '').slice(0, 600)
  })`)
  console.log(`\n=== ${t.url} ===`)
  console.log(JSON.stringify(JSON.parse(info), null, 1))
  if (t.url.includes('home.html')) {
    // Async work belongs INSIDE the page function: an `await` at the top level of the
    // string is not valid JavaScript, and the page-source guard in
    // test/page-source.test.mjs parses these templates precisely to catch that.
    const login = await evaluate(conn, `(async () => JSON.stringify({
      session: await ccwDesktop.getSessionStatus(),
      user: ccwDesktop.getUserData()
    }))()`, { awaitPromise: true }).catch((e) => `ERR ${e.message}`)
    console.log('login:', login)
  }
  conn.close()
}
