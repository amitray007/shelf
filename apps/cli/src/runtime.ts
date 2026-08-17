export interface CliKeyring {
  setPassword(service: string, account: string, password: string): Promise<void>;
  getPassword(service: string, account: string): Promise<string | null>;
  deletePassword(service: string, account: string): Promise<void>;
}

export interface CliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  fetch?: typeof globalThis.fetch;
  keyring?: CliKeyring;
}
