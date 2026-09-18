// Type declarations for the JS surface consumed by the TypeScript routing layer.
// Keep in sync with lib/handoff.js exports.

export interface HandoffTurn {
    role?: string;
    text?: string;
}

export interface HandoffConfig {
    enabled: boolean;
    numbers: string[];
    destinationNumbers: { contract: string; general: string };
    dialTimeoutSeconds: number;
    whisperAcceptDigit: string;
    whisperRejectDigit: string;
    callerId: string;
    blockNonHandoffBusiness?: boolean;
    requireBusinessCallback?: boolean;
    requireCallbackContact?: boolean;
    enforceRoutingPolicy?: boolean;
}

export const ACCOUNT_SID_PATTERN: RegExp;
export const CALL_SID_PATTERN: RegExp;
export const HANDOFF_DESTINATIONS: readonly string[];

export const PAYMENT_DISPUTE_PATTERNS: readonly RegExp[];
export const COMPLAINT_PATTERNS: readonly RegExp[];
export const COMPLEX_SUPPORT_PATTERNS: readonly RegExp[];
export const EMERGENCY_PATTERNS: readonly RegExp[];
export const CUSTOMER_HARASSMENT_PATTERNS: readonly RegExp[];
export const GENERAL_HANDOFF_PATTERNS: readonly RegExp[];
export const CONTRACT_REQUEST_PATTERNS: readonly RegExp[];
export const SALES_BUSINESS_PATTERNS: readonly RegExp[];
export const RECRUITING_APPLICANT_PATTERNS: readonly RegExp[];
export const PARTNERSHIP_AND_MEDIA_PATTERNS: readonly RegExp[];
export const EVENT_BUSINESS_PATTERNS: readonly RegExp[];
export const REPRESENTATIVE_REQUEST_PATTERNS: readonly RegExp[];

export function normalizeHandoffDestination(value: unknown): 'contract' | 'general';
export function buildHandoffConfig(options?: {
    HANDOFF_ENABLED?: boolean | string;
    HANDOFF_NUMBERS?: string;
    HANDOFF_DIAL_TIMEOUT_S?: number | string;
    HANDOFF_WHISPER_ACCEPT_DIGIT?: string;
    HANDOFF_WHISPER_REJECT_DIGIT?: string;
    HANDOFF_CALLER_ID?: string;
}): HandoffConfig;
export function buildTransferToHumanTool(config?: HandoffConfig): unknown;
export function appendHandoffInstructions(instructions: string, config?: HandoffConfig): string;
export function shouldAutoHandoffGeneral(turns?: HandoffTurn[]): boolean;
export function isComplaintCall(turns?: HandoffTurn[]): boolean;
export function isComplexSupportCall(turns?: HandoffTurn[]): boolean;
export function isEmergencyCall(turns?: HandoffTurn[]): boolean;
export function isCustomerHarassmentCall(turns?: HandoffTurn[]): boolean;
export function classifyGeneralHandoff(turns?: HandoffTurn[]): string;
export function isContractRequest(turns?: HandoffTurn[]): boolean;
export function isNonHandoffBusinessCall(turns?: HandoffTurn[]): boolean;
export function isSalesBusinessCall(turns?: HandoffTurn[]): boolean;
export function shouldAllowHumanHandoff(turns?: HandoffTurn[], destination?: string): boolean;
export function resolveHandoffDestination(turns?: HandoffTurn[], destination?: string): 'contract' | 'general';
export function isHandoffCallConnected(dialCallStatus: unknown, context?: { status?: string }): boolean;
export function findTransferToHumanToolCalls(event: unknown): Array<{ callId: string; reason: string; destination: 'contract' | 'general' }>;
export function summarizeHandoffTurns(turns?: HandoffTurn[], options?: { maxTurns?: number; maxChars?: number }): string;
export function summarizeHandoffWhisper(turns?: HandoffTurn[], options?: { maxTurns?: number; maxChars?: number }): string;
