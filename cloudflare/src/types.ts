import type {
  GuestVault,
  AuthorizationFlow,
  CleanupIndex,
  OAuthClients,
} from "./objects.js";
export interface State {
  storage: {
    sql: {
      exec<T = Record<string, unknown>>(
        query: string,
        ...args: (string | number | null)[]
      ): Iterable<T> & { toArray(): T[] };
    };
    transactionSync<T>(callback: () => T): T;
    setAlarm(time: number): Promise<void>;
    deleteAlarm(): Promise<void>;
    deleteAll(): Promise<void>;
  };
  blockConcurrencyWhile<T>(fn: () => Promise<T>): Promise<T>;
}
interface Namespace<T> {
  getByName(name: string): T;
}
export interface Env {
  VAULTS: Namespace<GuestVault>;
  FLOWS: Namespace<AuthorizationFlow>;
  CLEANUP: Namespace<CleanupIndex>;
  CLIENTS: Namespace<OAuthClients>;
  RATE_LIMITER: {
    limit(input: { key: string }): Promise<{ success: boolean }>;
  };
  PUBLIC_ORIGIN: string;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  ROOT_KEY: string;
  REDIRECT_URIS: string;
  ENROLLMENT_ENABLED?: string;
  DCR_ENABLED?: string;
  // Public information routes are opt-in and require a publisher-supplied contact.
  PUBLIC_PAGES_ENABLED?: string;
  PUBLIC_CONTACT?: string;
  // Public domain-ownership proof, not an OAuth credential.
  OPENAI_DOMAIN_VERIFICATION_TOKEN?: string;
}
export interface Authorization {
  clientId: string;
  clientExpiresAt?: number;
  redirectUri: string;
  state: string;
  challenge: string;
  resource: string;
  scope: string;
}
export interface ClientMetadata {
  redirect_uris: string[];
  client_name?: string;
  token_endpoint_auth_method: "client_secret_basic" | "client_secret_post";
  grant_types: string[];
  response_types: string[];
  scope: string;
}
export interface RegisteredClient {
  clientId: string;
  created: number;
  // Legacy fixed expiry is ignored: ChatGPT reuses a client across reconnects.
  expires?: number;
  secretHash: string;
  metadata: ClientMetadata;
}
export interface Meta {
  id: string;
  label: string;
  expires: number;
  revision: number;
  recovery: string;
  created: number;
  schemaVersion?: 2;
  basketExpires?: number | null;
  dataEpoch?: string;
  lastBasketExpiredAt?: number;
  shoppingListRevision?: number;
}
export interface Credential {
  kind: "code" | "access" | "refresh";
  grant: string;
  expires: number;
  used: boolean;
  activated?: boolean;
  challenge?: string;
  redirectUri?: string;
}
export interface Flow {
  expires: number;
  authorization: Authorization;
  browser: string;
  csrf: string;
  vault: string;
  decision?: "new" | "recover" | "deny";
  recoveryHash?: string;
  // Consent prepared successfully; recovery takeover waits for /continue.
  confirmed?: boolean;
}
