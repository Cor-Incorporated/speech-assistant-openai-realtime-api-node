import assert from 'node:assert/strict';
import test from 'node:test';
import { CallLogSinks } from '../lib/call-log-sinks.js';

test('disabled call log sinks do not require destination identifiers', () => {
    const sinks = new CallLogSinks();

    assert.equal(sinks.firestoreEnabled, false);
    assert.equal(sinks.sheetsEnabled, false);
});

test('enabled Firestore sink requires an explicit database id', () => {
    assert.throws(
        () => new CallLogSinks({ firestoreEnabled: 'true' }),
        /CALL_LOG_FIRESTORE_DATABASE_ID is required/
    );
});

test('enabled Sheets sink requires an explicit spreadsheet id', () => {
    assert.throws(
        () => new CallLogSinks({ sheetsEnabled: 'true' }),
        /GOOGLE_SHEETS_SPREADSHEET_ID is required/
    );
});

test('enabled sinks accept explicit destination identifiers', () => {
    const sinks = new CallLogSinks({
        firestoreEnabled: 'true',
        firestoreDatabaseId: 'call-log-db',
        sheetsEnabled: 'true',
        spreadsheetId: 'spreadsheet-id'
    });

    assert.equal(sinks.firestoreEnabled, true);
    assert.equal(sinks.firestoreDatabaseId, 'call-log-db');
    assert.equal(sinks.sheetsEnabled, true);
    assert.equal(sinks.spreadsheetId, 'spreadsheet-id');
});
