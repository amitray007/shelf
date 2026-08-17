export interface CliRuntime {
  env: Readonly<Record<string, string | undefined>>;
  stdout: (chunk: string) => void;
  stderr: (chunk: string) => void;
  fetch?: typeof globalThis.fetch;
}
