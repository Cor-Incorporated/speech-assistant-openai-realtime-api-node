import { defineConfig } from '@playwright/test';

const PORT = Number(process.env.E2E_PORT || 8109);

/**
 * Admin v2 E2E — runs against the REAL server (`node index.js`) with
 * in-memory repositories (CALL_LOG_FIRESTORE_ENABLED=false). No mocks:
 * every save/reload/conflict goes through Fastify + the compiled backend.
 *
 *   npx playwright test            # starts the server automatically
 *   E2E_PORT=xxxx                  # override the port
 */
export default defineConfig({
    testDir: './e2e',
    timeout: 30_000,
    retries: 0,
    workers: 1, // the server holds in-memory state — keep runs serialized
    use: {
        baseURL: `http://127.0.0.1:${PORT}`,
        httpCredentials: { username: 'admin', password: 'e2e-secret' },
        trace: 'retain-on-failure'
    },
    webServer: {
        command: `node index.js`,
        url: `http://127.0.0.1:${PORT}/healthz`,
        reuseExistingServer: false,
        timeout: 20_000,
        env: {
            PORT: String(PORT),
            ADMIN_BASIC_USER: 'admin',
            ADMIN_BASIC_PASSWORD: 'e2e-secret',
            CALL_LOG_FIRESTORE_ENABLED: 'false',
            TWILIO_SIGNATURE_VALIDATION_ENABLED: 'false',
            TWILIO_STREAM_AUTH_ENABLED: 'false',
            NOTIFY_EMAIL_ENABLED: 'false',
            ADMIN_V2_SUBJECT_MAP: JSON.stringify({
                admin: {
                    subject: 'e2e@cor.example',
                    roles: ['operator', 'knowledge_editor', 'knowledge_approver', 'supervisor'],
                    sharedAccount: false
                }
            })
        }
    }
});
