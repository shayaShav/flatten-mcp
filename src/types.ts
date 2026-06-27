export interface SessionMessage {
    type: 'user' | 'assistant' | 'system' | 'progress' | 'file-history-snapshot' | 'queue-operation';
    sessionId: string;
    timestamp: string;
    gitBranch?: string;
    uuid: string;
    cwd?: string;
    version?: string;
    message?: {
        role: string;
        content: string | ContentBlock[];
    };
    subtype?: string;
}

export interface ContentBlock {
    type: 'text' | 'tool_use' | 'tool_result' | 'image';
    text?: string;
    // Assistant tool_use blocks carry their own `id` (the tool_use_id that the
    // matching user tool_result later references). Distinct from tool_use_id.
    id?: string;
    name?: string;
    input?: Record<string, unknown>;
    content?: string | ContentBlock[];
    tool_use_id?: string;
    is_error?: boolean;
    // Image blocks (e.g. screenshots inside tool_result content arrays)
    source?: { type: string; media_type?: string; data?: string };
}

export interface SessionMeta {
    sessionId: string;
    timestamp: string;
    gitBranch: string;
    messageCount: number;
    fileSize: number;
    firstUserMessage: string;
    filePath: string;
}
