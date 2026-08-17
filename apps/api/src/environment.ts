export type ShelfEnvironment = Readonly<Record<string, string | undefined>>;

export function requiredEnvironmentValue(environment: ShelfEnvironment, name: string): string {
  const value = environment[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is required.`);
  return value;
}

export function installationIdFromEnvironment(environment: ShelfEnvironment): string {
  const installationId = requiredEnvironmentValue(environment, 'SHELF_INSTALLATION_ID');
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(installationId)) {
    throw new Error('SHELF_INSTALLATION_ID is invalid.');
  }
  return installationId;
}
