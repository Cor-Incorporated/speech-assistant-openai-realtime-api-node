import assert from 'node:assert/strict';
import test from 'node:test';
import { CallLogSinks } from '../lib/call-log-sinks.js';

const createFakeFirestore = () => {
    const sets = [];

    return {
        sets,
        collection(collectionName) {
            return {
                doc(documentId) {
                    return {
                        async set(data, options) {
                            sets.push({
                                collectionName,
                                documentId,
                                data,
                                options
                            });
                        }
                    };
                }
            };
        }
    };
};

const createFakeSheets = ({ existingHeader = [['通話ID']] } = {}) => {
    const calls = {
        getSpreadsheet: [],
        getValues: [],
        updateValues: [],
        appendValues: []
    };

    return {
        calls,
        spreadsheets: {
            async get(params) {
                calls.getSpreadsheet.push(params);
                return {
                    data: {
                        sheets: [
                            {
                                properties: {
                                    title: 'Calls'
                                }
                            }
                        ]
                    }
                };
            },
            values: {
                async get(params) {
                    calls.getValues.push(params);
                    return {
                        data: {
                            values: existingHeader
                        }
                    };
                },
                async update(params) {
                    calls.updateValues.push(params);
                    return {};
                },
                async append(params) {
                    calls.appendValues.push(params);
                    return {};
                }
            }
        }
    };
};

const createCompletedRecord = (overrides = {}) => ({
    callSid: 'CA_REAL_123',
    streamSid: 'MZ_REAL_123',
    accountSid: 'AC_REAL_123',
    from: '+81300000000',
    to: '+81311111111',
    startedAt: '2026-01-01T00:00:00.000Z',
    endedAt: '2026-01-01T00:01:00.000Z',
    startedAtJst: '2026-01-01 09:00:00',
    endedAtJst: '2026-01-01 09:01:00',
    durationSeconds: 60,
    status: 'completed',
    disconnectReason: 'twilio_ws_close_1000',
    openAiCloseCode: '',
    openAiError: '',
    transcript: '予約について相談したいです。',
    turns: [],
    extraction: null,
    summary: '予約相談',
    intent: 'reservation',
    callbackRequired: true,
    customerName: '山田太郎',
    customerPhoneNumber: '+819000000000',
    preferredDatetime: '2026-01-02 10:00',
    createdAt: '2026-01-01T00:01:01.000Z',
    ...overrides
});

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

test('CA_SMOKE sessions and completed records do not write to enabled sinks by default', async () => {
    const firestore = createFakeFirestore();
    const sheets = createFakeSheets();
    const sinks = new CallLogSinks({
        firestoreEnabled: 'true',
        firestoreDatabaseId: 'call-log-db',
        sheetsEnabled: 'true',
        spreadsheetId: 'spreadsheet-id',
        sheetsRange: "'Calls'!A:O"
    });
    sinks.firestore = firestore;
    sinks.sheets = sheets;

    await sinks.recordStarted({
        id: 'session-1',
        callSid: 'CA_SMOKE_123',
        streamSid: 'MZ_SMOKE_123',
        startedAt: new Date('2026-01-01T00:00:00.000Z')
    });
    await sinks.recordCompleted(createCompletedRecord({
        callSid: 'CA_SMOKE_123'
    }));

    assert.deepEqual(firestore.sets, []);
    assert.deepEqual(sheets.calls.getSpreadsheet, []);
    assert.deepEqual(sheets.calls.getValues, []);
    assert.deepEqual(sheets.calls.updateValues, []);
    assert.deepEqual(sheets.calls.appendValues, []);
});

test('real call starts and completed records still write to enabled sinks', async (t) => {
    t.mock.method(console, 'log', () => {});

    const firestore = createFakeFirestore();
    const sheets = createFakeSheets();
    const sinks = new CallLogSinks({
        firestoreEnabled: 'true',
        firestoreDatabaseId: 'call-log-db',
        firestoreCollection: 'callLogs',
        sheetsEnabled: 'true',
        spreadsheetId: 'spreadsheet-id',
        sheetsRange: "'Calls'!A:O"
    });
    sinks.firestore = firestore;
    sinks.sheets = sheets;

    await sinks.recordStarted({
        id: 'session-1',
        callSid: 'CA_REAL_123',
        streamSid: 'MZ_REAL_123',
        accountSid: 'AC_REAL_123',
        from: '+81300000000',
        to: '+81311111111',
        startedAt: new Date('2026-01-01T00:00:00.000Z')
    });
    await sinks.recordCompleted(createCompletedRecord());

    assert.equal(firestore.sets.length, 2);
    assert.equal(firestore.sets[0].collectionName, 'callLogs');
    assert.equal(firestore.sets[0].documentId, 'CA_REAL_123');
    assert.equal(firestore.sets[0].data.status, 'in_progress');
    assert.equal(firestore.sets[0].data.from, '+81300000000');
    assert.deepEqual(firestore.sets[0].options, { merge: true });
    assert.equal(firestore.sets[1].documentId, 'CA_REAL_123');
    assert.equal(firestore.sets[1].data.status, 'completed');
    assert.equal(firestore.sets[1].data.summary, '予約相談');
    assert.deepEqual(firestore.sets[1].options, { merge: true });

    assert.deepEqual(sheets.calls.getSpreadsheet, []);
    assert.equal(sheets.calls.getValues.length, 1);
    assert.equal(sheets.calls.updateValues.length, 0);
    assert.equal(sheets.calls.appendValues.length, 1);
    assert.equal(sheets.calls.appendValues[0].spreadsheetId, 'spreadsheet-id');
    assert.equal(sheets.calls.appendValues[0].range, "'Calls'!A:O");
    assert.equal(sheets.calls.appendValues[0].requestBody.values[0][0], 'CA_REAL_123');
    assert.equal(sheets.calls.appendValues[0].requestBody.values[0][4], "'+81300000000");
});
