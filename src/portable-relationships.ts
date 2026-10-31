import { DEPENDENCY_KIND_VALUES, itemDocumentToMutationOptions, isTimestampLiteral, normalizeDependencySourceKind } from '@unbrained/pm-cli/sdk';

/** Validate every represented edge field before any tracker preparation, using the SDK projection too. */
export function validRelationship(value: unknown, target: 'id' | 'slug'): boolean {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const edge = value as Record<string, unknown>;
  if (!Object.hasOwn(edge, target) || !Object.hasOwn(edge, 'kind') || Object.keys(edge).some(key => ![target, 'kind', 'created_at', 'author', 'source_kind', 'author_source'].includes(key)) || typeof edge[target] !== 'string' || edge[target].trim() === '' || !DEPENDENCY_KIND_VALUES.some(kind => kind === edge.kind)) return false;
  for (const key of ['created_at', 'author', 'source_kind']) if (Object.hasOwn(edge, key) && typeof edge[key] !== 'string') return false;
  if (Object.hasOwn(edge, 'author_source') && (typeof edge.author_source !== 'string' || !['asserted', 'detected', 'legacy'].includes(edge.author_source))) return false;
  if (typeof edge.created_at === 'string' && !isTimestampLiteral(edge.created_at)) return false;
  try { normalizeDependencySourceKind(edge.source_kind as string | undefined); itemDocumentToMutationOptions(JSON.stringify({ dependencies: [{ ...edge, id: edge[target] }] }), 'update'); return true; } catch { return false; }
}
