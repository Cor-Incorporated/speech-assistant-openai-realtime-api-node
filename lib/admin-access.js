// Shared authentication/authorization boundary for legacy and v2 admin APIs.
// Unknown Basic-auth subjects remain viewers across every route surface.
const VALID_ROLES = new Set([
    'viewer', 'operator', 'knowledge_editor', 'knowledge_approver',
    'supervisor', 'privacy_admin', 'ingestion_service'
]);

export const parseAdminSubjectMap = (raw) => {
    if (!raw) return {};
    try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        return Object.fromEntries(Object.entries(parsed)
            .filter(([, spec]) => spec && typeof spec === 'object' && !Array.isArray(spec))
            .map(([user, spec]) => [user, {
                subject: typeof spec.subject === 'string' && spec.subject ? spec.subject : user,
                roles: Array.isArray(spec.roles) ? spec.roles.filter((role) => VALID_ROLES.has(role)) : [],
                sharedAccount: spec.sharedAccount !== false
            }]));
    } catch {
        return {};
    }
};

export const deriveAdminActor = (username, subjectMap) => {
    const entry = Object.hasOwn(subjectMap, username) ? subjectMap[username] : null;
    return entry ?? { subject: username, roles: ['viewer'], sharedAccount: true };
};

export const checkAdminWriteGuards = (request, reply) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) return true;
    const origin = request.headers.origin || request.headers.referer;
    if (origin) {
        const expectedHost = String(request.headers['x-forwarded-host'] || request.headers.host || '').split(',')[0].trim();
        try {
            if (new URL(origin).host !== expectedHost) throw new Error('cross-origin');
        } catch {
            reply.code(403).send({ code: 'CSRF_ORIGIN', message: 'cross-origin write rejected', requestId: request.id });
            return false;
        }
    }
    const hasBody = request.body !== undefined || Number(request.headers['content-length'] || 0) > 0 || request.headers['transfer-encoding'];
    if (hasBody && !/^application\/json(?:\s*;|$)/i.test(String(request.headers['content-type'] || ''))) {
        reply.code(415).send({ code: 'UNSUPPORTED_MEDIA', message: 'writes require application/json', requestId: request.id });
        return false;
    }
    return true;
};

export function createAdminPermissionGuard({
    auth,
    permission,
    subjectMap = parseAdminSubjectMap(process.env.ADMIN_V2_SUBJECT_MAP),
    auditLog = () => {}
} = {}) {
    return async (request, reply) => {
        reply.header('Cache-Control', 'private, no-store');
        const result = typeof auth === 'function' ? await auth(request)
            : typeof auth?.authenticate === 'function' ? await auth.authenticate(request)
                : typeof auth?.verify === 'function' ? await auth.verify(request) : { ok: false, configured: false };
        request.adminAuth = result;
        if (!result?.ok) {
            if (result?.configured === false || result?.statusCode === 503) {
                return reply.code(503).send({ error: 'admin_auth_unconfigured', message: 'Admin API credentials are not configured' });
            }
            auditLog('admin.auth.failure', { actor: 'anonymous', target: request.url, result: 'failure', metadata: { reason: result?.reason || 'unauthorized' } });
            return reply.header('WWW-Authenticate', 'Basic realm="Cor Voice Admin"').code(401).send({ error: 'unauthorized' });
        }
        request.adminActor = deriveAdminActor(result.actor || '', subjectMap);
        let hasPermission;
        try {
            // The compiled backend owns the permission matrix. A missing build
            // must not silently restore unrestricted legacy access.
            ({ hasPermission } = await import('../dist-backend/admin/permissions.js'));
        } catch {
            return reply.code(503).send({ error: 'admin_permissions_unavailable' });
        }
        if (!hasPermission(request.adminActor, permission)) {
            auditLog('admin.permission.denied', { actor: request.adminActor.subject, target: request.url, result: 'failure', metadata: { permission } });
            return reply.code(403).send({ code: 'FORBIDDEN', message: `${permission} permission required`, requestId: request.id });
        }
        checkAdminWriteGuards(request, reply);
    };
}
