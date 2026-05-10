import { Firestore } from '@google-cloud/firestore';
import { google } from 'googleapis';

const SHEET_HEADERS = [
    '通話ID',
    '開始時刻',
    '終了時刻',
    '通話秒数',
    '発信者番号',
    '着信番号',
    '用件',
    '要約',
    '折り返し要否',
    '顧客名',
    '顧客電話番号',
    '希望日時',
    'ステータス',
    '切断理由',
    '文字起こし'
];

const toBool = (value) => value === true || value === 'true';
const toIsoString = (value) => {
    if (!value) return '';
    if (value instanceof Date) return value.toISOString();
    return new Date(value).toISOString();
};

const toJstString = (value) => {
    if (!value) return '';
    const date = value instanceof Date ? value : new Date(value);
    const parts = new Intl.DateTimeFormat('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false
    }).formatToParts(date);
    const get = (type) => parts.find(part => part.type === type)?.value || '';
    return `${get('year')}-${get('month')}-${get('day')} ${get('hour')}:${get('minute')}:${get('second')}`;
};

const sanitizeSheetValue = (value) => {
    if (value === null || value === undefined) return '';
    if (Array.isArray(value)) return value.join(', ');
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
};

const asSheetText = (value) => {
    const text = sanitizeSheetValue(value);
    return text ? `'${text}` : '';
};

export function buildCallLogRecord(session, extraction = null) {
    const startedAt = session.startedAt || new Date();
    const endedAt = session.endedAt || new Date();
    const durationSeconds = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 1000));

    return {
        callSid: session.callSid || session.id,
        streamSid: session.streamSid || '',
        accountSid: session.accountSid || '',
        from: session.from || '',
        to: session.to || '',
        startedAt: toIsoString(startedAt),
        endedAt: toIsoString(endedAt),
        startedAtJst: toJstString(startedAt),
        endedAtJst: toJstString(endedAt),
        durationSeconds,
        status: session.status || 'completed',
        disconnectReason: session.disconnectReason || '',
        openAiCloseCode: session.openAiCloseCode || '',
        openAiError: session.openAiError || '',
        transcript: session.transcript || '',
        turns: session.turns || [],
        extraction: extraction || null,
        summary: extraction?.summary || '',
        intent: extraction?.intent || '',
        callbackRequired: Boolean(extraction?.callbackRequired),
        customerName: extraction?.customerName || '',
        customerPhoneNumber: extraction?.customerPhoneNumber || '',
        preferredDatetime: extraction?.preferredDatetime || '',
        createdAt: new Date().toISOString()
    };
}

export class CallLogSinks {
    constructor({
        firestoreEnabled = false,
        firestoreDatabaseId = 'your-firestore-database-id',
        firestoreCollection = 'callLogs',
        sheetsEnabled = false,
        spreadsheetId = '',
        sheetsRange = '',
        googleProjectId = ''
    } = {}) {
        this.firestoreEnabled = toBool(firestoreEnabled);
        this.firestoreDatabaseId = firestoreDatabaseId;
        this.firestoreCollection = firestoreCollection;
        this.sheetsEnabled = toBool(sheetsEnabled) && Boolean(spreadsheetId);
        this.spreadsheetId = spreadsheetId;
        this.sheetsRange = sheetsRange;
        this.googleProjectId = googleProjectId;
        this.firestore = null;
        this.sheets = null;
        this.resolvedSheetsRange = null;
    }

    async recordStarted(session) {
        if (!this.firestoreEnabled) return;

        try {
            const firestore = this.getFirestore();
            await firestore.collection(this.firestoreCollection).doc(session.callSid || session.id).set({
                callSid: session.callSid || session.id,
                streamSid: session.streamSid || '',
                accountSid: session.accountSid || '',
                from: session.from || '',
                to: session.to || '',
                startedAt: toIsoString(session.startedAt),
                status: 'in_progress',
                updatedAt: new Date().toISOString()
            }, { merge: true });
        } catch (error) {
            console.error('Failed to write call start to Firestore:', error.message);
        }
    }

    async recordCompleted(record) {
        await Promise.allSettled([
            this.writeFirestore(record),
            this.appendSheet(record)
        ]);
    }

    getFirestore() {
        if (!this.firestore) {
            this.firestore = new Firestore({
                projectId: this.googleProjectId || undefined,
                databaseId: this.firestoreDatabaseId || undefined
            });
        }
        return this.firestore;
    }

    async getSheets() {
        if (!this.sheets) {
            const auth = new google.auth.GoogleAuth({
                scopes: ['https://www.googleapis.com/auth/spreadsheets']
            });
            this.sheets = google.sheets({ version: 'v4', auth });
        }
        return this.sheets;
    }

    async writeFirestore(record) {
        if (!this.firestoreEnabled) return;

        try {
            const firestore = this.getFirestore();
            await firestore.collection(this.firestoreCollection).doc(record.callSid).set({
                ...record,
                updatedAt: new Date().toISOString()
            }, { merge: true });
            console.log(`Call log saved to Firestore: ${record.callSid}`);
        } catch (error) {
            console.error('Failed to write call log to Firestore:', error.message);
        }
    }

    async appendSheet(record) {
        if (!this.sheetsEnabled) return;

        try {
            const sheets = await this.getSheets();
            const range = await this.getSheetRange(sheets);
            await this.ensureSheetHeader(sheets, range);
            await sheets.spreadsheets.values.append({
                spreadsheetId: this.spreadsheetId,
                range,
                valueInputOption: 'USER_ENTERED',
                insertDataOption: 'INSERT_ROWS',
                requestBody: {
                    values: [this.toSheetRow(record)]
                }
            });
            console.log(`Call log appended to Google Sheets: ${record.callSid}`);
        } catch (error) {
            console.error('Failed to append call log to Google Sheets:', error.message);
        }
    }

    async getSheetRange(sheets) {
        if (this.resolvedSheetsRange) return this.resolvedSheetsRange;
        if (this.sheetsRange) {
            this.resolvedSheetsRange = this.sheetsRange;
            return this.resolvedSheetsRange;
        }

        const spreadsheet = await sheets.spreadsheets.get({
            spreadsheetId: this.spreadsheetId,
            fields: 'sheets.properties.title'
        });
        const title = spreadsheet.data.sheets?.[0]?.properties?.title || 'Sheet1';
        this.resolvedSheetsRange = `'${title.replaceAll("'", "''")}'!A:O`;
        return this.resolvedSheetsRange;
    }

    async ensureSheetHeader(sheets, range) {
        const sheetName = range.includes('!') ? range.split('!')[0] : '';
        const headerRange = sheetName ? `${sheetName}!A1:O1` : 'A1:O1';
        const existing = await sheets.spreadsheets.values.get({
            spreadsheetId: this.spreadsheetId,
            range: headerRange
        });

        if (existing.data.values?.[0]?.length) return;

        await sheets.spreadsheets.values.update({
            spreadsheetId: this.spreadsheetId,
            range: headerRange,
            valueInputOption: 'USER_ENTERED',
            requestBody: {
                values: [SHEET_HEADERS]
            }
        });
    }

    toSheetRow(record) {
        return [
            record.callSid,
            record.startedAtJst || record.startedAt,
            record.endedAtJst || record.endedAt,
            record.durationSeconds,
            asSheetText(record.from),
            asSheetText(record.to),
            record.intent,
            record.summary,
            record.callbackRequired ? '要' : '不要',
            record.customerName,
            asSheetText(record.customerPhoneNumber),
            record.preferredDatetime,
            record.status,
            record.disconnectReason || record.openAiError,
            record.transcript
        ].map(sanitizeSheetValue);
    }
}

export { SHEET_HEADERS };
