// Type stubs for @earendil-works/pi-coding-agent (pi runtime provides these)
declare module "@earendil-works/pi-coding-agent" {
  export interface ContextUsage {
    /** Estimated context tokens, or null if unknown (e.g. right after compaction). */
    tokens: number | null;
    /** Context window size for the active model. May be undefined for some providers. */
    contextWindow: number | undefined;
    /** Context usage as percentage (0-100) of context window, or null if tokens is unknown. */
    percent: number | null;
  }

  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
    registerTool(definition: any): void;
    registerCommand(name: string, options: any): void;
    appendEntry(customType: string, data?: any): void;
    log?(level: string, message: string): void;
  }
}
