// Retired one-shot utility. It was used once to probe the R2 bucket's CORS
// policy (which turned out to be correct — the real upload blocker was the app's
// CSP connect-src omitting the R2 host). Neutralised: returns 410 and does
// nothing. Kept as a stub so redeploying from the repo can't reintroduce the
// admin behaviour.
Deno.serve(() => new Response(JSON.stringify({ error: 'gone' }), { status: 410, headers: { 'Content-Type': 'application/json' } }))
