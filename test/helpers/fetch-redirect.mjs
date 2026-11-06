// Test-only preload (node --import). Redirects the third-party HTTPS APIs the
// server calls (Twilio REST, OpenAI HTTP, Resend) to a local stub so the real
// index.js can run end to end without credentials or network access.
const stubBase = process.env.FETCH_STUB_URL;
const redirected = new Set(['api.twilio.com', 'api.openai.com', 'api.resend.com']);
const realFetch = globalThis.fetch;

if (stubBase) {
    globalThis.fetch = (input, init) => {
        const raw = typeof input === 'string' ? input : (input?.url || String(input));
        const url = new URL(raw);
        if (redirected.has(url.host)) {
            return realFetch(`${stubBase}/${url.host}${url.pathname}${url.search}`, init);
        }
        return realFetch(input, init);
    };
}
