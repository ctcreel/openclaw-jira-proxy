/**
 * `kind` is workspace-declared (any string the workspace ships a JSON
 * Schema for), with one reserved value: `'stranger'`. ResolvedActor
 * therefore narrows to `kind: string` excluding `'stranger'` — the
 * discriminant is purely the value, not a closed enum.
 */
export interface ResolvedActor {
  kind: Exclude<string, 'stranger'>;
  id: string;
  name: string;
  [property: string]: unknown;
}

export interface StrangerActor {
  kind: 'stranger';
  id: null;
  email: string | null;
}

export type Actor = ResolvedActor | StrangerActor;

export function isStranger(actor: Actor): actor is StrangerActor {
  return actor.kind === 'stranger';
}

export function isResolved(actor: Actor): actor is ResolvedActor {
  return actor.kind !== 'stranger';
}
