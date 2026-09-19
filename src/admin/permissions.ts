// Server-side authorization for the admin v2 surface.
// Roles are bundles of permissions; the actor's roles come from the
// authenticated subject — never from request body fields like `role` or
// `approvedBy`, which a client could forge.

export const PERMISSIONS = [
    'calls.read',          // masked overview
    'calls.read_pii',      // names, numbers, full transcripts
    'calls.create_manual',
    'calls.correct',       // corrections + effective business fields
    'calls.delete',
    'calls.restore',
    'calls.export',
    'calls.purge',
    'calls.severity.raise',
    'calls.severity.lower',
    'knowledge.read',
    'knowledge.edit',      // draft CRUD + submit for review
    'knowledge.approve',
    'knowledge.publish',
    'knowledge.withdraw',
    'sources.edit',
    'reviews.resolve',
    'escalations.read',
    'escalations.assign',
    'escalations.acknowledge',
    'escalations.resolve',
    'policies.edit',
    'policies.publish',
    'audit.read',
    'privacy.execute',
    'imports.dry_run',
    'imports.execute'
] as const;

export type Permission = (typeof PERMISSIONS)[number];

export const ROLES = [
    'viewer',
    'operator',
    'knowledge_editor',
    'knowledge_approver',
    'supervisor',
    'privacy_admin',
    'ingestion_service'
] as const;

export type Role = (typeof ROLES)[number];

const ROLE_PERMISSIONS: Record<Role, readonly Permission[]> = {
    viewer: ['calls.read', 'knowledge.read', 'escalations.read'],
    operator: [
        'calls.read',
        'calls.read_pii',
        'calls.create_manual',
        'calls.correct',
        'calls.severity.raise',
        'knowledge.read',
        'escalations.read',
        'escalations.acknowledge'
    ],
    knowledge_editor: [
        'knowledge.read',
        'knowledge.edit',
        'sources.edit',
        'imports.dry_run'
    ],
    knowledge_approver: [
        'knowledge.read',
        'knowledge.edit',
        'knowledge.approve',
        'knowledge.publish',
        'knowledge.withdraw',
        'sources.edit',
        'reviews.resolve',
        'imports.dry_run'
    ],
    supervisor: [
        'calls.read',
        'calls.read_pii',
        'calls.create_manual',
        'calls.correct',
        'calls.delete',
        'calls.restore',
        'calls.severity.raise',
        'calls.severity.lower',
        'knowledge.read',
        'escalations.read',
        'escalations.assign',
        'escalations.acknowledge',
        'escalations.resolve',
        'audit.read',
        'imports.dry_run'
    ],
    privacy_admin: [
        'calls.read',
        'calls.read_pii',
        'calls.export',
        'calls.purge',
        'privacy.execute',
        'audit.read',
        'imports.dry_run'
    ],
    ingestion_service: []
};

export interface Actor {
    /** Stable authenticated subject id (OIDC sub or explicit dev identity). */
    subject: string;
    roles: readonly Role[];
    /** Shared accounts (e.g. legacy Basic auth) cannot perform actions that
     * require individual accountability — publish, purge, approval. */
    sharedAccount: boolean;
}

/** Actions that demand a personally attributable actor, not a shared login. */
const INDIVIDUAL_ONLY: ReadonlySet<Permission> = new Set([
    'knowledge.approve',
    'knowledge.publish',
    'calls.purge',
    'privacy.execute',
    'escalations.acknowledge'
]);

export function permissionsFor(actor: Actor): ReadonlySet<Permission> {
    const granted = new Set<Permission>();
    for (const role of actor.roles) {
        for (const permission of ROLE_PERMISSIONS[role] ?? []) {
            granted.add(permission);
        }
    }
    if (actor.sharedAccount) {
        for (const permission of INDIVIDUAL_ONLY) granted.delete(permission);
    }
    return granted;
}

export function hasPermission(actor: Actor, permission: Permission): boolean {
    return permissionsFor(actor).has(permission);
}

/** Authn for local development/tests. Production wiring supplies a verified
 * subject; a missing subject fails closed rather than defaulting to admin. */
export function devActor(subject: string, roles: readonly Role[], sharedAccount = false): Actor {
    return { subject, roles, sharedAccount };
}
