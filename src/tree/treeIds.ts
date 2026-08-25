export function folderId(fullName: string): string {
  return `folder:${fullName}`;
}

export function jobId(fullName: string): string {
  return `job:${fullName}`;
}

export function buildId(fullName: string, number: number): string {
  return `build:${fullName}#${number}`;
}

export function buildsMoreId(fullName: string, cursor: string | number): string {
  return `builds-more:${fullName}:${cursor}`;
}
