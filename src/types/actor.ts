export interface ResolvedActor {
  kind: string;
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
