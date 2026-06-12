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

export interface SearchResult {
    sessionId: string;
    timestamp: string;
    gitBranch: string;
    matchCount: number;
    matchPreview: string;
    fileSize: number;
}
