/**
 * Observer contract for the SquashageDagonizer's five lifecycle hooks.
 *
 * Engine-agnostic. The dispatcher subclass forwards each hook call here; the
 * concrete observer chooses what to do (write PROV-O, log to stdout, drop on
 * the floor for tests).
 */
export interface ProvObserverInterface {
  recordFlowStart(dagName: string): void;
  recordFlowEnd(dagName: string, lifecycleKind: string): void;
  recordNodeStart(nodeName: string): void;
  recordNodeEnd(nodeName: string, output: string | null): void;
  recordError(nodeName: string, error: Error): void;
}
