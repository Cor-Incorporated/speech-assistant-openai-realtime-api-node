import { FieldPath, type CollectionReference, type DocumentData, type Query } from '@google-cloud/firestore';

const SCAN_LIMIT = 500;
type Position = { key: string | null; id: string };
type Row<T> = Position & { record: T };

class InvalidCursorError extends Error {
    readonly statusCode = 400;
    readonly code = 'INVALID_CURSOR';
    constructor() { super('invalid or expired pagination cursor; reload the list'); }
}

const decodeCursor = (cursor: string | undefined, scope: string): Position | null => {
    if (!cursor) return null;
    try {
        if (!cursor.startsWith('p1.') || cursor.length > 4096) throw new Error();
        const encoded = cursor.slice(3);
        const bytes = Buffer.from(encoded, 'base64url');
        if (bytes.toString('base64url') !== encoded) throw new Error();
        const value = JSON.parse(bytes.toString('utf8'));
        if (value.scope !== scope || typeof value.id !== 'string' || !value.id || value.id.includes('/') ||
            Buffer.byteLength(value.id) > 1500 || (value.key !== null && (typeof value.key !== 'string' || value.key.length > 200))) throw new Error();
        return { key: value.key, id: value.id };
    } catch {
        throw new InvalidCursorError();
    }
};

const encodeCursor = (position: Position, scope: string) => `p1.${Buffer.from(JSON.stringify({ scope, ...position })).toString('base64url')}`;

// Firestore's single-field descending index already ends in __name__ DESC.
// The tuple is sufficient after the cursor document is deleted, and resolves
// ties without skips when many records have the same timestamp.
const comparePositions = (a: Position, b: Position): number => {
    if (a.key !== b.key) {
        if (a.key === null) return 1;
        if (b.key === null) return -1;
        return a.key < b.key ? 1 : -1;
    }
    return Buffer.compare(Buffer.from(b.id), Buffer.from(a.id));
};

const pageRows = <T>(rows: Row<T>[], scope: string, limit: number, include: (record: T) => boolean) => {
    const items: T[] = [];
    let consumed = 0;
    while (consumed < rows.length && consumed < SCAN_LIMIT && items.length < limit) {
        const row = rows[consumed++]!;
        if (include(row.record)) items.push(row.record);
    }
    const hasMore = consumed < rows.length;
    const last = consumed ? rows[consumed - 1]! : null;
    return {
        items,
        nextCursor: hasMore && last ? encodeCursor({ key: last.key, id: last.id }, scope) : null,
        hasMore,
        partial: hasMore
    };
};

const pageLimit = (limit = 50): number => {
    if (!Number.isInteger(limit) || limit < 1 || limit > 200) {
        const error = new Error('limit must be an integer from 1 to 200') as Error & { statusCode: number; code: string };
        error.statusCode = 422;
        error.code = 'VALIDATION';
        throw error;
    }
    return limit;
};

export function memoryRecordPage<T>(records: T[], options: {
    scope: string; limit?: number; cursor?: string; position: (record: T) => Position; include: (record: T) => boolean;
}) {
    const limit = pageLimit(options.limit);
    const after = decodeCursor(options.cursor, options.scope);
    const rows = records.map((record) => ({ ...options.position(record), record }))
        .filter((row) => !after || comparePositions(row, after) > 0)
        .sort(comparePositions)
        .slice(0, SCAN_LIMIT + 1);
    return pageRows(rows, options.scope, limit, options.include);
}

export async function firestoreRecordPage<T>(collection: CollectionReference<DocumentData>, options: {
    scope: string; orderField: string; limit?: number; cursor?: string; include: (record: T) => boolean;
}) {
    const limit = pageLimit(options.limit);
    const after = decodeCursor(options.cursor, options.scope);
    let query: Query = collection.orderBy(options.orderField, 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (after) query = query.startAfter(after.key, after.id);
    const snapshot = await query.limit(SCAN_LIMIT + 1).get();
    const rows = snapshot.docs.map((doc) => {
        const record = doc.data();
        return { id: doc.id, key: (record[options.orderField] ?? null) as string | null, record: record as T };
    });
    return pageRows(rows, options.scope, limit, options.include);
}
