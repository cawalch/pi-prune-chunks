// Type stubs for @earendil-works/pi-coding-agent (pi runtime provides these)
declare module "@earendil-works/pi-coding-agent" {
  export interface ExtensionAPI {
    on(event: string, handler: (event: any, ctx: any) => Promise<any>): void;
    registerTool(definition: any): void;
    registerCommand(name: string, options: any): void;
    appendEntry(customType: string, data?: any): void;
    log?(level: string, message: string): void;
  }
}
