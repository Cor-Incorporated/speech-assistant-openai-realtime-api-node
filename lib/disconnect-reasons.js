const TWILIO_CLOSE_REASONS = {
    1000: {
        category: 'normal',
        label: '通話またはWebSocketが正常終了しました'
    },
    1001: {
        category: 'normal',
        label: 'Twilio Media Streamsが接続終了を通知しました'
    },
    1005: {
        category: 'normal',
        label: 'Twilio Media Streamsが理由コードなしで切断しました'
    },
    1006: {
        category: 'warning',
        label: 'Twilio Media Streamsの接続が異常終了しました'
    }
};

export const describeDisconnectReason = ({
    disconnectReason = '',
    openAiCloseCode = '',
    openAiError = ''
} = {}) => {
    if (openAiError) {
        return {
            category: 'error',
            label: 'OpenAI Realtime API接続エラー',
            raw: openAiError
        };
    }

    const rawReason = String(disconnectReason || '').trim();
    const twilioMatch = rawReason.match(/^twilio_ws_close_(\d+)$/);
    if (twilioMatch) {
        const code = Number(twilioMatch[1]);
        const reason = TWILIO_CLOSE_REASONS[code] || {
            category: 'unknown',
            label: `Twilio Media StreamsがWebSocketを終了しました (${code})`
        };

        return {
            ...reason,
            raw: rawReason,
            code
        };
    }

    if (rawReason) {
        return {
            category: 'unknown',
            label: rawReason,
            raw: rawReason
        };
    }

    if (openAiCloseCode) {
        return {
            category: 'unknown',
            label: `OpenAI Realtime APIが接続を終了しました (${openAiCloseCode})`,
            raw: String(openAiCloseCode)
        };
    }

    return {
        category: 'unknown',
        label: '切断理由は記録されていません',
        raw: ''
    };
};
