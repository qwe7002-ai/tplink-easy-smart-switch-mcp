export interface Session {
  cookies: Map<string, string>;
}

export interface HttpResult {
  status: number;
  url: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  raw_head: string;
}

export interface FormattedPage {
  title: string | null;
  text: string;
  forms: Array<Record<string, unknown>>;
  frames: Array<Record<string, string | null>>;
  links: Array<Record<string, string | null>>;
  scripts: Array<Record<string, string | null>>;
  tables: string[][];
}

export interface CgiRequestPlan {
  description: string;
  action: string;
  method: "GET" | "POST";
  referer: string;
  params: Array<[string, string]>;
  will_submit: boolean;
}

export interface SaveConfigDiscovery {
  action: string;
  method: "GET" | "POST";
  params: Array<[string, string]>;
  source: "form" | "script" | "fallback";
  confidence: "high" | "medium" | "fallback";
  note?: string;
}

export interface SwitchEntry {
  name: string;
  host: string;
  username?: string;
  password?: string;
}

export interface SwitchConfig {
  switches: SwitchEntry[];
  default?: string;
}
